import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import type { Deps } from "../context.js";
import { notifyTargets, type NotifyTarget, type User } from "../db/schema.js";
import { newId, randomString } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { parseList } from "../lib/senders.js";
import { NOTIFY_EVENTS, sendTo } from "../services/notify.js";
import { OutboundUrlError, checkOutboundUrl } from "../lib/outbound.js";

/** Tokens are write-only: only a hint is returned. */
const out = (t: NotifyTarget) => ({
  id: t.id,
  kind: t.kind,
  name: t.name,
  url: t.url,
  chat_id: t.chatId,
  has_token: !!t.token,
  secret: t.kind === "webhook" ? t.secret : null,
  events: parseList(t.eventsJson),
  enabled: t.enabled,
  last_ok_at: t.lastOkAt,
  last_error: t.lastError,
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
        events: Events.default(["code.received", "leak.detected", "address.expiring", "address.burned"]),
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
      if (body.url !== undefined && t.kind !== "telegram") await checkUrl(d, user, body.url);
      const set: Partial<NotifyTarget> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.url !== undefined && t.kind !== "telegram") set.url = body.url;
      if (body.token) set.token = body.token;
      if (body.chat_id !== undefined) set.chatId = body.chat_id || null;
      if (body.events) set.eventsJson = JSON.stringify(body.events);
      if (body.enabled !== undefined) set.enabled = body.enabled;
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
}
