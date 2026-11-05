import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import type { Deps } from "../context.js";
import { notifyTargets, webhookDeliveries, type NotifyTarget, type User } from "../db/schema.js";
import { newId, randomString } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { parseList } from "../lib/senders.js";
import { NOTIFY_EVENTS, sendTo } from "../services/notify.js";
import { vapidKeys } from "../services/webpush.js";
import { OutboundUrlError, checkOutboundUrl } from "../lib/outbound.js";
import { attempt, deliveryOut, redeliver } from "../services/webhooks.js";

/** Tokens are write-only: only a hint is returned. */
const out = (t: NotifyTarget) => ({
  id: t.id,
  kind: t.kind,
  name: t.name,
  url: t.url,
  chat_id: t.chatId,
  // Web Push: the endpoint identifies the browser, the keys stay on the server.
  has_token: !!t.token,
  secret: t.kind === "webhook" ? t.secret : null,
  events: parseList(t.eventsJson),
  enabled: t.enabled,
  last_ok_at: t.lastOkAt,
  last_error: t.lastError,
  consecutive_failures: t.consecutiveFailures,
  paused_at: t.pausedAt,
  created_at: t.createdAt,
});

function owned(d: Deps, user: User, id: string) {
  const t = d.db
    .select()
    .from(notifyTargets)
    .where(and(eq(notifyTargets.id, id), eq(notifyTargets.userId, user.id)))
    .get();
  if (!t) throw notFound("Notification target");
  return t;
}

async function checkUrl(d: Deps, user: User, url: string | undefined) {
  if (!url) throw badRequest("url is required");
  try {
    // Only admins may point the server at its own network (Home Assistant, a LAN ntfy...).
    await checkOutboundUrl(url, { resolve: d.resolve, allowPrivate: user.role === "admin" });
  } catch (e) {
    if (e instanceof OutboundUrlError)
      throw badRequest(`url: ${e.message}${user.role !== "admin" && /private|local/.test(e.message) ? " (reserved to admins)" : ""}`);
    throw e;
  }
}

const Events = z.array(z.enum(NOTIFY_EVENTS)).min(1);
const DEFAULT_EVENTS: (typeof NOTIFY_EVENTS)[number][] = [
  "code.received",
  "leak.detected",
  "address.expiring",
  "address.burned",
  "address.rotated",
];

export function registerNotify(r: ApiRouter) {
  r.add(
    { method: "get", path: "/v1/notify-targets", summary: "List own notification targets", tags: ["notifications"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      return c.json({
        targets: d.db
          .select()
          .from(notifyTargets)
          .where(eq(notifyTargets.userId, c.get("user")!.id))
          .orderBy(asc(notifyTargets.createdAt))
          .all()
          .map(out),
      });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/notify-targets",
      summary: "Add a notification target (ntfy, Gotify, Telegram or signed webhook)",
      description: "Webhooks are POSTed as JSON with x-tm-timestamp and x-tm-signature = hex HMAC-SHA256(secret, `${timestamp}.${body}`).",
      tags: ["notifications"],
      auth: "user",
      body: z.object({
        kind: z.enum(["ntfy", "gotify", "telegram", "webhook"]),
        name: z.string().trim().min(1).max(80),
        url: z.string().trim().max(500).optional(),
        token: z.string().trim().max(300).optional(),
        chat_id: z.string().trim().max(64).optional(),
        events: Events.default(DEFAULT_EVENTS),
      }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      if (body.kind === "telegram") {
        if (!body.token || !body.chat_id) throw badRequest("Telegram needs a bot token and a chat_id");
      } else await checkUrl(d, user, body.url);
      if (body.kind === "gotify" && !body.token) throw badRequest("Gotify needs an application token");
      const row = {
        id: newId("ntf"),
        userId: user.id,
        kind: body.kind,
        name: body.name,
        url: body.kind === "telegram" ? null : body.url!,
        token: body.token || null,
        chatId: body.chat_id || null,
        secret: body.kind === "webhook" ? randomString(32) : null,
        eventsJson: JSON.stringify(body.events),
        createdAt: d.now(),
      };
      d.db.insert(notifyTargets).values(row).run();
      return c.json({ target: out(owned(d, user, row.id)) }, 201);
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/push/vapid-key",
      summary: "Public VAPID key for Web Push subscriptions",
      tags: ["notifications"],
      auth: "user",
    },
    (c) => c.json({ public_key: vapidKeys(c.get("deps")).publicKey }),
  );

  r.add(
    {
      method: "post",
      path: "/v1/push/subscriptions",
      summary: "Register this browser for Web Push notifications",
      description:
        "Body: the browser's PushSubscription (endpoint and keys). Creates a `webpush` notification target, or updates the one with the same endpoint.",
      tags: ["notifications"],
      auth: "user",
      body: z.object({
        endpoint: z.string().trim().url().max(1000),
        keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }),
        name: z.string().trim().min(1).max(80).default("This browser"),
        events: Events.default(DEFAULT_EVENTS),
      }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      if (!body.endpoint.startsWith("https://")) throw badRequest("endpoint must be an https:// URL");
      try {
        // Push services are public hosts; never let a subscription point the server at its own network.
        await checkOutboundUrl(body.endpoint, { resolve: d.resolve, allowPrivate: false });
      } catch (e) {
        if (e instanceof OutboundUrlError) throw badRequest(`endpoint: ${e.message}`);
        throw e;
      }
      const token = JSON.stringify(body.keys);
      const existing = d.db
        .select()
        .from(notifyTargets)
        .where(and(eq(notifyTargets.userId, user.id), eq(notifyTargets.kind, "webpush"), eq(notifyTargets.url, body.endpoint)))
        .get();
      if (existing) {
        d.db.update(notifyTargets).set({ token, enabled: true, lastError: null }).where(eq(notifyTargets.id, existing.id)).run();
        return c.json({ target: out(owned(d, user, existing.id)) });
      }
      const id = newId("ntf");
      d.db
        .insert(notifyTargets)
        .values({
          id,
          userId: user.id,
          kind: "webpush",
          name: body.name,
          url: body.endpoint,
          token,
          eventsJson: JSON.stringify(body.events),
          createdAt: d.now(),
        })
        .run();
      return c.json({ target: out(owned(d, user, id)) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/notify-targets/:id",
      summary: "Update a notification target",
      tags: ["notifications"],
      auth: "user",
      body: z.object({
        name: z.string().trim().min(1).max(80).optional(),
        url: z.string().trim().max(500).optional(),
        token: z.string().trim().max(300).optional(),
        chat_id: z.string().trim().max(64).optional(),
        events: Events.optional(),
        enabled: z.boolean().optional(),
      }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const t = owned(d, user, c.req.param("id")!);
      const urlEditable = t.kind !== "telegram" && t.kind !== "webpush";
      if (body.url !== undefined && urlEditable) await checkUrl(d, user, body.url);
      const set: Partial<NotifyTarget> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.url !== undefined && urlEditable) set.url = body.url;
      if (body.token && t.kind !== "webpush") set.token = body.token;
      if (body.chat_id !== undefined) set.chatId = body.chat_id || null;
      if (body.events) set.eventsJson = JSON.stringify(body.events);
      if (body.enabled !== undefined) set.enabled = body.enabled;
      // Enabling again also resumes a webhook paused after repeated failures.
      if (body.enabled) Object.assign(set, { pausedAt: null, consecutiveFailures: 0 });
      if (Object.keys(set).length) d.db.update(notifyTargets).set(set).where(eq(notifyTargets.id, t.id)).run();
      return c.json({ target: out(owned(d, user, t.id)) });
    },
  );

  r.add(
    { method: "delete", path: "/v1/notify-targets/:id", summary: "Remove a notification target", tags: ["notifications"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      const t = owned(d, c.get("user")!, c.req.param("id")!);
      d.db.delete(notifyTargets).where(eq(notifyTargets.id, t.id)).run();
      return c.json({ ok: true });
    },
  );

  r.add(
    { method: "post", path: "/v1/notify-targets/:id/test", summary: "Send a test notification", tags: ["notifications"], auth: "user" },
    async (c) => {
      const d = c.get("deps");
      const t = owned(d, c.get("user")!, c.req.param("id")!);
      const res = await sendTo(d, t, {
        type: "code.received",
        title: "Throwaway Mail test",
        body: "Code 123456 for example.com (test)",
        url: d.config.APP_URL,
        data: { test: true },
      });
      return c.json(res);
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/notify-targets/:id/deliveries",
      summary: "Recent deliveries of a webhook (kept 14 days, newest first)",
      tags: ["notifications"],
      auth: "user",
      query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const t = owned(d, c.get("user")!, c.req.param("id")!);
      const rows = d.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.targetId, t.id))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(query.limit)
        .all();
      return c.json({ deliveries: rows.map(deliveryOut) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/notify-targets/:id/deliveries/:did/resend",
      summary: "Send a delivery again (same event id and body, new signature)",
      tags: ["notifications"],
      auth: "user",
    },
    async (c) => {
      const d = c.get("deps");
      const t = owned(d, c.get("user")!, c.req.param("id")!);
      const old = d.db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.id, c.req.param("did")!), eq(webhookDeliveries.targetId, t.id)))
        .get();
      if (!old) throw notFound("Delivery");
      const row = redeliver(d, old);
      const res = await attempt(d, row.id);
      const now = d.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row.id)).get()!;
      return c.json({
        ok: res?.ok ?? false,
        error: res?.error ?? (res ? undefined : "target paused or disabled"),
        delivery: deliveryOut(now),
      });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/notify-targets/:id/resume",
      summary: "Resume a webhook paused after repeated failures (pending deliveries are retried)",
      tags: ["notifications"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const t = owned(d, c.get("user")!, c.req.param("id")!);
      d.db.update(notifyTargets).set({ pausedAt: null, consecutiveFailures: 0, enabled: true }).where(eq(notifyTargets.id, t.id)).run();
      return c.json({ target: out(owned(d, c.get("user")!, t.id)) });
    },
  );
}
