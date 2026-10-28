import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Deps } from "../context.js";
import { notifyTargets, type NotifyTarget } from "../db/schema.js";
import { parseList } from "../lib/senders.js";
import { metrics } from "./metrics.js";

export const NOTIFY_EVENTS = ["message.received", "code.received", "leak.detected", "address.expiring", "address.burned"] as const;
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

/** Hosts a non-admin may not target: loopback, link-local, private ranges, LAN-only names. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  if (!h.includes(".")) return !h.includes(":") ? true : /^(::1?|fe80:|fc|fd)/.test(h);
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function webhookSignature(secret: string, ts: string, body: string) {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

function request(t: NotifyTarget, e: NotifyEvent, now: number): { url: string; init: RequestInit } {
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) => ({
    url,
    init: { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
  });
  switch (t.kind) {
    case "ntfy": {
      const headers: Record<string, string> = { title: e.title, tags: e.type === "leak.detected" ? "warning" : "email" };
      if (e.url) headers.click = e.url;
      if (e.type === "leak.detected") headers.priority = "high";
      if (t.token) headers.authorization = `Bearer ${t.token}`;
      return { url: t.url!, init: { method: "POST", headers, body: e.body } };
    }
    case "gotify":
      return json(`${t.url!.replace(/\/$/, "")}/message`, { title: e.title, message: e.body + (e.url ? `\n${e.url}` : ""), priority: e.type === "leak.detected" ? 8 : 5 }, { "x-gotify-key": t.token ?? "" });
    case "telegram":
      return json(`https://api.telegram.org/bot${t.token}/sendMessage`, { chat_id: t.chatId, text: `${e.title}\n${e.body}${e.url ? `\n${e.url}` : ""}`, disable_web_page_preview: true });
    case "webhook": {
      const body = JSON.stringify({ type: e.type, title: e.title, body: e.body, url: e.url ?? null, sent_at: now, ...e.data });
      const ts = String(Math.floor(now / 1000));
      return {
        url: t.url!,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", "x-tm-event": e.type, "x-tm-timestamp": ts, ...(t.secret ? { "x-tm-signature": webhookSignature(t.secret, ts, body) } : {}) },
          body,
        },
      };
    }
  }
}

/** Sends one event to one target; records the outcome. */
export async function sendTo(deps: Deps, t: NotifyTarget, e: NotifyEvent): Promise<{ ok: boolean; error?: string }> {
  const { url, init } = request(t, e, deps.now());
  try {
    const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    .filter((t) => parseList(t.eventsJson).includes(e.type));
  return Promise.all(targets.map((t) => sendTo(deps, t, e)));
}
