import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Ctx, ApiRouter } from "../lib/http.js";
import { parseTimestamp } from "../lib/http.js";
import { messages } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { itemsOut, messageOut, messageSummaryOut } from "../services/serialize.js";
import { itemsFor, ownedAddress } from "../services/addresses.js";

/** Messages of an address: listing, reading, archiving, bulk actions and the latest-code long poll. */
export function registerMessages(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/addresses/:id/messages",
      summary: "List messages received by an address (newest first)",
      tags: ["messages"],
      auth: "user",
      description: "archived=false (default) lists the inbox, archived=true the archive, archived=all both.",
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().optional(),
        archived: z.enum(["false", "true", "all"]).default("false"),
      }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a } = ownedAddress(d, user, c.req.param("id")!);
      const conds: SQL[] = [eq(messages.addressId, a.id), eq(messages.userId, user.id)];
      if (query.archived === "false") conds.push(isNull(messages.archivedAt));
      if (query.archived === "true") conds.push(isNotNull(messages.archivedAt));
      if (query.before) conds.push(lt(messages.receivedAt, query.before));
      const rows = d.db.select().from(messages).where(and(...conds)).orderBy(desc(messages.receivedAt)).limit(query.limit).all();
      const items = itemsFor(d, rows.map((m) => m.id));
      return c.json({ messages: rows.map((m) => messageSummaryOut(m, items.get(m.id) ?? [])) });
    },
  );

  const ownedMessage = (c: Ctx) => {
    const d = c.get("deps");
    const m = d.db.select().from(messages).where(and(eq(messages.id, c.req.param("id")!), eq(messages.userId, c.get("user")!.id))).get();
    if (!m) throw notFound("Message");
    return m;
  };

  r.add({ method: "get", path: "/v1/messages/:id", summary: "Get a message with extracted codes and links", tags: ["messages"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const m = ownedMessage(c);
    return c.json({ message: messageOut(m, itemsFor(d, [m.id]).get(m.id) ?? []) });
  });

  r.add(
    {
      method: "patch",
      path: "/v1/messages/:id",
      summary: "Mark a message read/unread, archive or unarchive it",
      tags: ["messages"],
      auth: "user",
      body: z.object({ read: z.boolean().optional(), archived: z.boolean().optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const m = ownedMessage(c);
      const set: { readAt?: number | null; archivedAt?: number | null } = {};
      if (body.read !== undefined) set.readAt = body.read ? (m.readAt ?? d.now()) : null;
      if (body.archived !== undefined) {
        set.archivedAt = body.archived ? (m.archivedAt ?? d.now()) : null;
        if (body.archived) set.readAt = m.readAt ?? d.now();
      }
      if (Object.keys(set).length) d.db.update(messages).set(set).where(eq(messages.id, m.id)).run();
      d.bus.publish(m.userId, { type: "address.updated", address_id: m.addressId });
      return c.json({ ok: true });
    },
  );

  r.add({ method: "delete", path: "/v1/messages/:id", summary: "Delete a message", tags: ["messages"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const m = ownedMessage(c);
    d.db.delete(messages).where(eq(messages.id, m.id)).run();
    d.bus.publish(m.userId, { type: "address.updated", address_id: m.addressId });
    return c.json({ ok: true });
  });

  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/messages/bulk",
      summary: "Act on several messages of an address at once",
      description: "Either `ids` or `scope` (inbox = not archived, archived, read = read and not archived, all).",
      tags: ["messages"],
      auth: "user",
      body: z
        .object({
          action: z.enum(["read", "archive", "unarchive", "delete"]),
          ids: z.array(z.string()).max(1000).optional(),
          scope: z.enum(["inbox", "archived", "read", "all"]).optional(),
        })
        .refine((b) => !!b.ids !== !!b.scope, "Give either ids or scope"),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a } = ownedAddress(d, user, c.req.param("id")!);
      const conds: SQL[] = [eq(messages.addressId, a.id), eq(messages.userId, user.id)];
      if (body.ids) conds.push(inArray(messages.id, body.ids.length ? body.ids : ["-"]));
      if (body.scope === "inbox") conds.push(isNull(messages.archivedAt));
      if (body.scope === "archived") conds.push(isNotNull(messages.archivedAt));
      if (body.scope === "read") conds.push(isNull(messages.archivedAt), isNotNull(messages.readAt));
      const where = and(...conds);
      const now = d.now();
      const res =
        body.action === "delete"
          ? d.db.delete(messages).where(where).run()
          : body.action === "read"
            ? d.db.update(messages).set({ readAt: now }).where(and(where, isNull(messages.readAt))).run()
            : body.action === "archive"
              ? d.db.update(messages).set({ archivedAt: now, readAt: sql`coalesce(${messages.readAt}, ${now})` }).where(and(where, isNull(messages.archivedAt))).run()
              : d.db.update(messages).set({ archivedAt: null }).where(where).run();
      d.bus.publish(user.id, { type: "address.updated", address_id: a.id });
      return c.json({ ok: true, affected: res.changes });
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/addresses/:id/code",
      summary: "Latest verification code (long-poll)",
      description:
        "Returns the newest message (received after `since`, if given) that has a code — or, with require=any, a code or a verification link. " +
        "If none is available yet, waits up to `wait` seconds (max 60) for one to arrive. Returns 204 on timeout. " +
        "`since` accepts epoch milliseconds/seconds, an ISO date, or a message id.",
      tags: ["messages"],
      auth: "user",
      query: z.object({
        wait: z.coerce.number().min(0).max(60).default(0),
        since: z.string().optional(),
        require: z.enum(["code", "any"]).default("any"),
      }),
      responses: { 200: "{ code, alternatives, links, message_id, received_at, confidence, subject, from }", 204: "Nothing arrived before the timeout" },
    },
    async (c, { query }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a } = ownedAddress(d, user, c.req.param("id")!);
      let sinceTs: number | null = null;
      let sinceId: string | null = null;
      if (query.since) {
        const ref = d.db.select().from(messages).where(and(eq(messages.id, query.since), eq(messages.userId, user.id))).get();
        if (ref) {
          sinceTs = ref.receivedAt;
          sinceId = ref.id;
        } else {
          sinceTs = parseTimestamp(query.since);
          if (sinceTs === null) throw badRequest("since must be a timestamp, ISO date or message id");
        }
      }
      const find = () => {
        const conds: SQL[] = [eq(messages.addressId, a.id), eq(messages.userId, user.id)];
        if (sinceTs !== null) {
          conds.push(sinceId ? or(gt(messages.receivedAt, sinceTs), and(eq(messages.receivedAt, sinceTs), gt(messages.id, sinceId)))! : gt(messages.receivedAt, sinceTs));
        }
        const rows = d.db.select().from(messages).where(and(...conds)).orderBy(desc(messages.receivedAt)).limit(25).all();
        const items = itemsFor(d, rows.map((m) => m.id));
        for (const m of rows) {
          if (sinceId && m.id === sinceId) continue;
          const ex = itemsOut(items.get(m.id) ?? []);
          if (ex.code || (query.require === "any" && ex.links.length)) {
            return {
              code: ex.code?.value ?? null,
              confidence: ex.code?.confidence ?? null,
              alternatives: ex.alternatives,
              links: ex.links,
              message_id: m.id,
              received_at: m.receivedAt,
              subject: m.subject,
              from: m.fromAddr,
            };
          }
        }
        return null;
      };
      let result = find();
      if (!result && query.wait > 0) {
        const signal = c.req.raw.signal;
        result = await new Promise((resolve) => {
          let settled = false;
          const done = (v: ReturnType<typeof find>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsub();
            signal.removeEventListener("abort", onAbort);
            resolve(v);
          };
          const onAbort = () => done(null);
          const unsub = d.bus.subscribe(user.id, (e) => {
            if (e.type === "message.received" && e.address_id === a.id) {
              const r = find();
              if (r) done(r);
            }
          });
          const timer = setTimeout(() => done(find()), query.wait * 1000);
          signal.addEventListener("abort", onAbort);
        });
      }
      if (!result) return c.body(null, 204);
      return c.json(result);
    },
  );
}
