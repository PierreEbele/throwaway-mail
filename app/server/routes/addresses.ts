import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Ctx, ApiRouter } from "../lib/http.js";
import { parseTimestamp } from "../lib/http.js";
import type { Deps } from "../context.js";
import { addresses, categories, destinations, domains, extractedItems, messages, type Address, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { LOCAL_PART_RE } from "../lib/email.js";
import { readableLocalPart } from "../lib/words.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { addressOut, itemsOut, messageOut, messageSummaryOut } from "../services/serialize.js";
import { checkCategory, matchCategory } from "./categories.js";

const SiteUrl = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v))
  .pipe(z.union([z.literal(""), z.string().url()]))
  .transform((v) => v || null);

const ExpiresAt = z.union([z.number().int().positive(), z.string().datetime({ offset: true }), z.null()]).transform((v) => (typeof v === "string" ? Date.parse(v) : v));

function counts(deps: Deps, ids: string[]) {
  const map = new Map<string, { unread: number; total: number }>();
  if (!ids.length) return map;
  const rows = deps.db
    .select({
      id: messages.addressId,
      total: sql<number>`count(*)`,
      unread: sql<number>`sum(case when ${messages.readAt} is null and ${messages.archivedAt} is null then 1 else 0 end)`,
    })
    .from(messages)
    .where(inArray(messages.addressId, ids))
    .groupBy(messages.addressId)
    .all();
  for (const r of rows) map.set(r.id, { unread: r.unread ?? 0, total: r.total });
  return map;
}

/** Every address lookup is scoped by user id; another user's address is indistinguishable from a missing one. */
export function ownedAddress(deps: Deps, user: User, id: string) {
  const row = deps.db
    .select({ a: addresses, domain: domains.name })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(and(eq(addresses.id, id), eq(addresses.userId, user.id)))
    .get();
  if (!row) throw notFound("Address");
  return row;
}

function out(deps: Deps, a: Address, domain: string) {
  return addressOut(a, domain, counts(deps, [a.id]).get(a.id));
}

function checkDestination(deps: Deps, user: User, id: string | null | undefined) {
  if (!id) return;
  const d = deps.db.select().from(destinations).where(and(eq(destinations.id, id), eq(destinations.userId, user.id))).get();
  if (!d) throw badRequest("Unknown destination_id");
}

function itemsFor(deps: Deps, ids: string[]) {
  const map = new Map<string, (typeof extractedItems.$inferSelect)[]>();
  if (!ids.length) return map;
  for (const it of deps.db.select().from(extractedItems).where(inArray(extractedItems.messageId, ids)).all()) {
    (map.get(it.messageId) ?? map.set(it.messageId, []).get(it.messageId)!).push(it);
  }
  return map;
}

export interface NewAddress {
  domain?: string;
  site_name: string;
  site_url?: string | null;
  local_part?: string;
  label?: string;
  forward?: boolean;
  destination_id?: string;
  category_id?: string | null;
  expires_at?: number | null;
  expires_in_days?: number;
}

/** Creates an address for `user`. Shared by `POST /v1/addresses` and the alias-service compatibility API. */
export function createAddress(d: Deps, user: User, body: NewAddress): { a: Address; domain: string } {
  const domain = body.domain
    ? d.db.select().from(domains).where(or(eq(domains.name, body.domain), eq(domains.id, body.domain))).get()
    : d.db.select().from(domains).where(eq(domains.status, "active")).orderBy(asc(domains.createdAt)).get();
  if (!domain) throw badRequest(body.domain ? `Unknown domain ${body.domain}` : "No active domain is configured yet");
  if (domain.status !== "active") throw badRequest(`Domain ${domain.name} is not active yet`);
  if (body.local_part !== undefined && !LOCAL_PART_RE.test(body.local_part)) {
    throw badRequest("local_part may contain a-z, 0-9, '.', '_' and '-', must start and end with a letter or digit (max 64)");
  }
  checkDestination(d, user, body.destination_id);
  checkCategory(d, user, body.category_id);
  const now = d.now();
  const expiresAt = body.expires_at ?? (body.expires_in_days ? now + body.expires_in_days * 86400_000 : null);
  for (let attempt = 0; attempt < 12; attempt++) {
    const localPart = body.local_part ?? readableLocalPart();
    const row = {
      id: newId("adr"),
      userId: user.id,
      domainId: domain.id,
      localPart,
      siteName: body.site_name,
      siteUrl: body.site_url ?? null,
      label: body.label ?? null,
      forwardEnabled: body.forward ?? false,
      destinationId: body.destination_id ?? null,
      categoryId: body.category_id === undefined ? matchCategory(d, user.id, body.site_name, body.site_url ?? null) : body.category_id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    const res = d.db.insert(addresses).values(row).onConflictDoNothing().run();
    if (res.changes === 1) {
      const a = d.db.select().from(addresses).where(eq(addresses.id, row.id)).get()!;
      d.bus.publish(user.id, { type: "address.created", address_id: a.id });
      return { a, domain: domain.name };
    }
    if (body.local_part) throw conflict(`${body.local_part}@${domain.name} is already taken`);
  }
  throw conflict("Could not allocate a unique address, try again");
}

export function registerAddresses(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/addresses",
      summary: "Create an address for a site",
      description: "The local part defaults to a readable random string (word-word-1234). `domain` is a domain name or id; defaults to the first active domain.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({
        domain: z.string().trim().toLowerCase().optional(),
        site_name: z.string().trim().min(1).max(120),
        site_url: SiteUrl.optional(),
        local_part: z.string().trim().toLowerCase().optional(),
        label: z.string().trim().max(120).optional(),
        forward: z.boolean().optional(),
        destination_id: z.string().optional(),
        category_id: z.string().nullable().optional(),
        expires_at: ExpiresAt.optional(),
        expires_in_days: z.number().int().min(1).max(3650).optional(),
      }),
      responses: { 201: "Created: { id, email, address }" },
    },
    (c, { body }) => {
      const d = c.get("deps");
      const { a, domain } = createAddress(d, c.get("user")!, body);
      const o = out(d, a, domain);
      return c.json({ id: a.id, email: o.email, address: o }, 201);
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/addresses",
      summary: "List own addresses",
      description: "status defaults to everything except archived; use status=all to include archived.",
      tags: ["addresses"],
      auth: "user",
      query: z.object({
        site: z.string().optional(),
        domain: z.string().optional(),
        status: z.enum(["active", "paused", "archived", "all"]).optional(),
        q: z.string().optional(),
        category: z.string().optional().describe("Category id, or `none` for uncategorised addresses"),
        pinned: z.enum(["true", "false"]).optional(),
        hide_hidden: z.enum(["true", "false"]).optional().describe("Exclude addresses whose category is hidden (used by the Inbox)"),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const conds: SQL[] = [eq(addresses.userId, user.id), eq(addresses.isUnassigned, false)];
      if (query.status && query.status !== "all") conds.push(eq(addresses.status, query.status));
      else if (!query.status) conds.push(ne(addresses.status, "archived"));
      if (query.domain) conds.push(eq(domains.name, query.domain.toLowerCase()));
      if (query.category === "none") conds.push(isNull(addresses.categoryId));
      else if (query.category) conds.push(eq(addresses.categoryId, query.category));
      if (query.pinned) conds.push(eq(addresses.pinned, query.pinned === "true"));
      if (query.hide_hidden === "true") {
        conds.push(sql`(${addresses.categoryId} is null or not exists (select 1 from ${categories} where ${categories.id} = ${addresses.categoryId} and ${categories.hidden} = 1))`);
      }
      if (query.site) {
        const s = `%${query.site.toLowerCase()}%`;
        conds.push(or(like(sql`lower(${addresses.siteName})`, s), like(sql`lower(coalesce(${addresses.siteUrl}, ''))`, s))!);
      }
      if (query.q) {
        const s = `%${query.q.toLowerCase()}%`;
        conds.push(
          or(
            like(sql`lower(${addresses.localPart} || '@' || ${domains.name})`, s),
            like(sql`lower(${addresses.siteName})`, s),
            like(sql`lower(coalesce(${addresses.siteUrl}, ''))`, s),
            like(sql`lower(coalesce(${addresses.label}, ''))`, s),
            // Full-text-ish: the address also matches when one of its mails does.
            sql`exists (select 1 from ${messages} where ${messages.addressId} = ${addresses.id} and (lower(coalesce(${messages.subject}, '')) like ${s} or lower(coalesce(${messages.text}, '')) like ${s} or lower(coalesce(${messages.fromAddr}, '')) like ${s}))`,
          )!,
        );
      }
      const rows = d.db
        .select({ a: addresses, domain: domains.name })
        .from(addresses)
        .innerJoin(domains, eq(domains.id, addresses.domainId))
        .where(and(...conds))
        .orderBy(desc(addresses.pinned), desc(sql`coalesce(${addresses.lastMessageAt}, ${addresses.createdAt})`))
        .limit(query.limit)
        .offset(query.offset)
        .all();
      const cnt = counts(d, rows.map((x) => x.a.id));
      return c.json({ addresses: rows.map((x) => addressOut(x.a, x.domain, cnt.get(x.a.id))) });
    },
  );

  r.add({ method: "get", path: "/v1/addresses/:id", summary: "Get one address", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const { a, domain } = ownedAddress(d, c.get("user")!, c.req.param("id")!);
    return c.json({ address: out(d, a, domain) });
  });

  r.add(
    {
      method: "patch",
      path: "/v1/addresses/:id",
      summary: "Update an address (rename site, toggle forwarding, set destination, pause, archive)",
      tags: ["addresses"],
      auth: "user",
      body: z.object({
        site_name: z.string().trim().min(1).max(120).optional(),
        site_url: SiteUrl.optional(),
        label: z.string().trim().max(120).nullable().optional(),
        forward_enabled: z.boolean().optional(),
        destination_id: z.string().nullable().optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        expires_at: ExpiresAt.optional(),
        category_id: z.string().nullable().optional(),
        pinned: z.boolean().optional(),
        block_promos: z.boolean().optional(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a, domain } = ownedAddress(d, user, c.req.param("id")!);
      checkDestination(d, user, body.destination_id);
      checkCategory(d, user, body.category_id);
      const set: Partial<Address> = { updatedAt: d.now() };
      if (body.category_id !== undefined) set.categoryId = body.category_id;
      if (body.pinned !== undefined) set.pinned = body.pinned;
      if (body.block_promos !== undefined) set.blockPromos = body.block_promos;
      if (body.site_name !== undefined) set.siteName = body.site_name;
      if (body.site_url !== undefined) set.siteUrl = body.site_url;
      if (body.label !== undefined) set.label = body.label || null;
      if (body.forward_enabled !== undefined) set.forwardEnabled = body.forward_enabled;
      if (body.destination_id !== undefined) set.destinationId = body.destination_id;
      if (body.status !== undefined) set.status = body.status;
      if (body.expires_at !== undefined) set.expiresAt = body.expires_at;
      d.db.update(addresses).set(set).where(and(eq(addresses.id, a.id), eq(addresses.userId, user.id))).run();
      d.bus.publish(user.id, { type: "address.updated", address_id: a.id });
      return c.json({ address: out(d, d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain) });
    },
  );

  r.add({ method: "delete", path: "/v1/addresses/:id", summary: "Delete an address and all its messages", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const user = c.get("user")!;
    const { a } = ownedAddress(d, user, c.req.param("id")!);
    d.db.delete(addresses).where(and(eq(addresses.id, a.id), eq(addresses.userId, user.id))).run();
    d.bus.publish(user.id, { type: "address.deleted", address_id: a.id });
    return c.json({ ok: true });
  });

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
