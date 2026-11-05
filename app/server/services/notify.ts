import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, domains, notifyTargets, users, type NotifyTarget } from "../db/schema.js";
import type { AppEvent } from "./events.js";
import { safeFetchNoRedirect } from "../lib/outbound.js";
import { parseList } from "../lib/senders.js";
import { metrics } from "./metrics.js";
import { enqueueWebhooks } from "./webhooks.js";
import { webPushRequest } from "./webpush.js";

export const NOTIFY_EVENTS = [
  "message.received",
  "code.received",
  "leak.detected",
  "address.expiring",
  "address.burned",
  "system.alert",
  "message.sent",
  // Mostly for automation webhooks (n8n, Zapier, Home Assistant...); push targets may subscribe too.
  "address.created",
  "address.deleted",
  "address.expired",
  "message.blocked",
  "forward.failed",
] as const;
export type NotifyEventType = (typeof NOTIFY_EVENTS)[number];

export interface NotifyEvent {
  type: NotifyEventType;
  title: string;
  body: string;
  /** Link into the web UI. */
  url?: string;
  /** Extra fields sent as-is to webhooks. */
  data?: Record<string, unknown>;
}

export function webhookSignature(secret: string, ts: string, body: string) {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

function request(deps: Deps, t: NotifyTarget, e: NotifyEvent): { url: string; init: RequestInit } {
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) => ({
    url,
    init: { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
  });
  switch (t.kind) {
    case "ntfy": {
      const urgent = e.type === "leak.detected" || e.type === "system.alert";
      const headers: Record<string, string> = { title: e.title, tags: urgent ? "warning" : "email" };
      if (e.url) headers.click = e.url;
      if (urgent) headers.priority = "high";
      if (t.token) headers.authorization = `Bearer ${t.token}`;
      return { url: t.url!, init: { method: "POST", headers, body: e.body } };
    }
    case "gotify":
      return json(
        `${t.url!.replace(/\/$/, "")}/message`,
        {
          title: e.title,
          message: e.body + (e.url ? `\n${e.url}` : ""),
          priority: e.type === "leak.detected" || e.type === "system.alert" ? 8 : 5,
        },
        { "x-gotify-key": t.token ?? "" },
      );
    case "telegram":
      return json(`https://api.telegram.org/bot${t.token}/sendMessage`, {
        chat_id: t.chatId,
        text: `${e.title}\n${e.body}${e.url ? `\n${e.url}` : ""}`,
        disable_web_page_preview: true,
      });
    case "webpush":
      return webPushRequest(
        deps,
        t,
        { title: e.title, body: e.body, url: e.url, tag: e.type === "code.received" ? "code" : undefined },
        e.type === "code.received" || e.type === "leak.detected" || e.type === "system.alert",
      );
    case "webhook":
      throw new Error("webhooks go through the outbox (services/webhooks.ts)");
  }
}

/** Sends one event to one target; records the outcome. */
export async function sendTo(deps: Deps, t: NotifyTarget, e: NotifyEvent): Promise<{ ok: boolean; error?: string }> {
  if (t.kind === "webhook") {
    const [res] = (await enqueueWebhooks(deps, [t], e)) as Array<{ ok: boolean; error?: string } | null>;
    return res ?? { ok: false, error: t.pausedAt ? "paused after repeated failures" : "not sent" };
  }
  try {
    const { url, init } = request(deps, t, e);
    // Re-checked at every send: the target's DNS may have changed since it was saved.
    const owner = deps.db.select({ role: users.role }).from(users).where(eq(users.id, t.userId)).get();
    const res = await safeFetchNoRedirect(deps, url, init, { allowPrivate: owner?.role === "admin", timeoutMs: 8000 });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) {
      // The browser unsubscribed (or the subscription expired): stop sending to it.
      if (t.kind === "webpush" && (res.status === 404 || res.status === 410))
        deps.db.update(notifyTargets).set({ enabled: false }).where(eq(notifyTargets.id, t.id)).run();
      throw new Error(`HTTP ${res.status}`);
    }
    deps.db.update(notifyTargets).set({ lastOkAt: deps.now(), lastError: null }).where(eq(notifyTargets.id, t.id)).run();
    metrics.notify.inc({ kind: t.kind, result: "ok" });
    return { ok: true };
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    deps.db.update(notifyTargets).set({ lastError: error }).where(eq(notifyTargets.id, t.id)).run();
    metrics.notify.inc({ kind: t.kind, result: "error" });
    deps.logger.warn("notification failed", { target: t.id, kind: t.kind, err: error });
    return { ok: false, error };
  }
}

/** Fire-and-forget fan-out to every enabled target of `userId` subscribed to `e.type`. */
export function notify(deps: Deps, userId: string, e: NotifyEvent): Promise<unknown> {
  const targets = deps.db
    .select()
    .from(notifyTargets)
    .where(and(eq(notifyTargets.userId, userId), eq(notifyTargets.enabled, true)))
    .all()
    .filter((t) => parseList(t.eventsJson).includes(e.type) && !t.pausedAt);
  const hooks = targets.filter((t) => t.kind === "webhook");
  return Promise.all([enqueueWebhooks(deps, hooks, e), ...targets.filter((t) => t.kind !== "webhook").map((t) => sendTo(deps, t, e))]);
}

/** Instance problems (failed backup, failed end-to-end probe): every active admin's targets subscribed to system.alert. */
export function notifyAdmins(deps: Deps, e: Omit<NotifyEvent, "type">): Promise<unknown> {
  const admins = deps.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.disabled, false)))
    .all();
  return Promise.all(admins.map((a) => notify(deps, a.id, { ...e, type: "system.alert" })));
}

/** Turns live address events into address.created / address.deleted notifications (webhooks for automation). */
export function relayAddressEvents(deps: Deps, userId: string, e: AppEvent) {
  if ((e.type !== "address.created" && e.type !== "address.deleted") || !e.address_id) return;
  const link = `${deps.config.APP_URL.replace(/\/$/, "")}/addresses/${e.address_id}`;
  if (e.type === "address.deleted") {
    void notify(deps, userId, {
      type: "address.deleted",
      title: "Address deleted",
      body: `Address ${e.address_id} was deleted.`,
      data: { address_id: e.address_id },
    }).catch(() => {});
    return;
  }
  const row = deps.db
    .select({ a: addresses, domain: domains.name })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(eq(addresses.id, e.address_id))
    .get();
  if (!row) return;
  const email = `${row.a.localPart}@${row.domain}`;
  void notify(deps, userId, {
    type: "address.created",
    title: `New address for ${row.a.siteName}`,
    body: email,
    url: link,
    data: {
      address_id: row.a.id,
      address: email,
      site: row.a.siteName,
      site_url: row.a.siteUrl,
      label: row.a.label,
      expires_at: row.a.expiresAt,
      auto_created: row.a.label === "auto-created",
    },
  }).catch(() => {});
}
