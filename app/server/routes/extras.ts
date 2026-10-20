import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, categories, domains, extractedItems, leakEvents, messages, type Address } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { LOCAL_PART_RE } from "../lib/email.js";
import { badRequest } from "../lib/errors.js";
import { baseDomain, parseList, senderDomain } from "../lib/senders.js";
import { addressOut } from "../services/serialize.js";
import { isPrivateHost } from "../services/notify.js";
import { notFound } from "../lib/errors.js";
import { checkCategory, CATEGORY_COLORS } from "./categories.js";
import { createAddress, ownedAddress } from "./addresses.js";

const DAY = 86400_000;

export function registerExtras(r: ApiRouter) {
  // --- Bulk actions on several addresses --------------------------------------------------------
  r.add(
    {
      method: "post",
      path: "/v1/addresses/bulk",
      summary: "Apply one action to several addresses",
      tags: ["addresses"],
      auth: "user",
      body: z.object({
        ids: z.array(z.string()).min(1).max(1000),
        action: z.enum(["move", "pin", "unpin", "archive", "unarchive", "pause", "resume", "delete", "read"]),
        category_id: z.string().nullable().optional(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const where = and(eq(addresses.userId, user.id), inArray(addresses.id, body.ids));
      const now = d.now();
      let affected = 0;
      if (body.action === "move") {
        if (body.category_id === undefined) throw badRequest("category_id is required for move");
        checkCategory(d, user, body.category_id);
        affected = d.db.update(addresses).set({ categoryId: body.category_id, updatedAt: now }).where(where).run().changes;
      } else if (body.action === "delete") {
        affected = d.db.delete(addresses).where(where).run().changes;
      } else if (body.action === "read") {
        const ids = d.db.select({ id: addresses.id }).from(addresses).where(where).all().map((x) => x.id);
        if (ids.length) affected = d.db.update(messages).set({ readAt: now }).where(and(inArray(messages.addressId, ids), isNull(messages.readAt))).run().changes;
      } else {
        const set: Partial<Address> =
          body.action === "pin" ? { pinned: true }
          : body.action === "unpin" ? { pinned: false }
          : body.action === "archive" ? { status: "archived" }
          : body.action === "pause" ? { status: "paused" }
          : { status: "active" };
        affected = d.db.update(addresses).set({ ...set, updatedAt: now }).where(where).run().changes;
      }
      for (const id of body.ids) d.bus.publish(user.id, { type: body.action === "delete" ? "address.deleted" : "address.updated", address_id: id });
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ affected });
    },
  );

  // --- Leak response: replace a compromised address -------------------------------------------
  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/replace",
      summary: "Create a fresh address for the same site and pause the old one",
      description: "Copies site, category, forwarding, pin and protections. The old address is paused (mail rejected) and its leak warning cleared.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ archive_old: z.boolean().default(false) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a: old } = ownedAddress(d, user, c.req.param("id")!);
      const { a, domain } = createAddress(d, user, {
        domain: old.domainId,
        site_name: old.siteName,
        site_url: old.siteUrl,
        label: old.label ?? undefined,
        forward: old.forwardEnabled,
        destination_id: old.destinationId ?? undefined,
        category_id: old.categoryId,
      });
      d.db
        .update(addresses)
        .set({ pinned: old.pinned, blockPromos: old.blockPromos, siteLock: old.siteLock, blockedSendersJson: old.blockedSendersJson, trustedSendersJson: old.trustedSendersJson })
        .where(eq(addresses.id, a.id))
        .run();
      d.db
        .update(addresses)
        .set({ status: body.archive_old ? "archived" : "paused", pinned: false, leakSender: null, leakAt: null, label: `replaced by ${a.localPart}@${domain}`, updatedAt: d.now() })
        .where(eq(addresses.id, old.id))
        .run();
      d.bus.publish(user.id, { type: "address.updated", address_id: old.id });
      return c.json({ address: addressOut(d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain), replaced_id: old.id }, 201);
    },
  );

  // --- Panic button ------------------------------------------------------------------------------
  r.add(
    {
      method: "post",
      path: "/v1/panic",
      summary: "Pause every active address (or one category's) at once; undo resumes exactly those",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ action: z.enum(["pause", "undo"]).default("pause"), category_id: z.string().nullable().optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const now = d.now();
      let affected: number;
      if (body.action === "pause") {
        checkCategory(d, user, body.category_id);
        const conds = [eq(addresses.userId, user.id), eq(addresses.status, "active"), eq(addresses.isUnassigned, false)];
        if (body.category_id) conds.push(eq(addresses.categoryId, body.category_id));
        affected = d.db.update(addresses).set({ status: "paused", burnReason: "panic", burnedAt: now, updatedAt: now }).where(and(...conds)).run().changes;
      } else {
        affected = d.db
          .update(addresses)
          .set({ status: "active", burnReason: null, burnedAt: null, updatedAt: now })
          .where(and(eq(addresses.userId, user.id), eq(addresses.status, "paused"), eq(addresses.burnReason, "panic")))
          .run().changes;
      }
      d.bus.publish(user.id, { type: "address.updated", address_id: "" });
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ affected });
    },
  );

  // --- Senders: block / trust / dismiss leak warning -------------------------------------------
  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/senders",
      summary: "Block or trust a sender domain for an address, or dismiss its leak warning",
      description: "block: mail from this domain is rejected. trust: no leak warning for it. unblock/untrust undo. dismiss: clear the leak warning only.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ action: z.enum(["block", "unblock", "trust", "untrust", "dismiss"]), sender: z.string().trim().toLowerCase().max(255).optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a, domain } = ownedAddress(d, user, c.req.param("id")!);
      const raw = body.sender ?? a.leakSender ?? "";
      const dom = raw.includes("@") ? senderDomain(raw) : raw;
      const set: Partial<Address> = { updatedAt: d.now() };
      if (body.action !== "dismiss") {
        if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) throw badRequest("sender must be a domain or an e-mail address");
        const key = baseDomain(dom);
        const field = body.action.endsWith("block") ? "blockedSendersJson" : "trustedSendersJson";
        const list = new Set(parseList(a[field]));
        if (body.action === "block" || body.action === "trust") list.add(key);
        else list.delete(key);
        set[field] = list.size ? JSON.stringify([...list].sort()) : null;
      }
      if (body.action === "dismiss" || body.action === "trust" || body.action === "block") Object.assign(set, { leakSender: null, leakAt: null });
      d.db.update(addresses).set(set).where(eq(addresses.id, a.id)).run();
      d.bus.publish(user.id, { type: "address.updated", address_id: a.id });
      return c.json({ address: addressOut(d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain) });
    },
  );

  // --- Per-address statistics ------------------------------------------------------------------
  r.add({ method: "get", path: "/v1/addresses/:id/stats", summary: "Mail statistics for one address", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const user = c.get("user")!;
    const { a } = ownedAddress(d, user, c.req.param("id")!);
    const now = d.now();
    const rows = d.db
      .select({ id: messages.id, at: messages.receivedAt, from: messages.fromAddr, read: messages.readAt })
      .from(messages)
      .where(eq(messages.addressId, a.id))
      .all();
    const weeks = Array.from({ length: 12 }, () => 0);
    const senders = new Map<string, number>();
    for (const m of rows) {
      const w = Math.floor((now - m.at) / (7 * DAY));
      if (w >= 0 && w < 12) weeks[11 - w]!++;
      const s = senderDomain(m.from) ?? "unknown";
      senders.set(s, (senders.get(s) ?? 0) + 1);
    }
    const withCode = rows.length
      ? d.db
          .select({ n: sql<number>`count(distinct ${extractedItems.messageId})` })
          .from(extractedItems)
          .where(and(inArray(extractedItems.messageId, rows.map((m) => m.id)), eq(extractedItems.kind, "code"), eq(extractedItems.rank, 0)))
          .get()!.n
      : 0;
    return c.json({
      total: rows.length,
      unread: rows.filter((m) => !m.read).length,
      with_code: withCode,
      first_at: rows.length ? Math.min(...rows.map((m) => m.at)) : null,
      last_at: rows.length ? Math.max(...rows.map((m) => m.at)) : null,
      per_week: weeks,
      top_senders: [...senders].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([domain, count]) => ({ domain, count })),
    });
  });

  // --- One-click unsubscribe -------------------------------------------------------------------
  r.add(
    {
      method: "post",
      path: "/v1/messages/:id/unsubscribe",
      summary: "Unsubscribe from the newsletter a message came from",
      description:
        "With RFC 8058 one-click support the server POSTs the unsubscribe request itself (done: true). Otherwise the unsubscribe URL (or mailto) is returned for the user to open.",
      tags: ["messages"],
      auth: "user",
      body: z.object({ block: z.boolean().default(false).describe("Also reject future newsletters on this address") }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const m = d.db.select().from(messages).where(and(eq(messages.id, c.req.param("id")!), eq(messages.userId, user.id))).get();
      if (!m) throw notFound("Message");
      if (body.block) d.db.update(addresses).set({ blockPromos: true, updatedAt: d.now() }).where(and(eq(addresses.id, m.addressId), eq(addresses.userId, user.id))).run();
      if (!m.unsubscribeUrl && !m.unsubscribeMailto) throw badRequest("This message has no List-Unsubscribe header");
      let done = false;
      let error: string | null = null;
      // The URL comes from the sender: https only, never towards the server's own network.
      if (m.unsubscribeOneClick && m.unsubscribeUrl && !isPrivateHost(new URL(m.unsubscribeUrl).hostname)) {
        try {
          const res = await d.fetch(m.unsubscribeUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
          done = res.ok;
          if (!res.ok) error = `HTTP ${res.status}`;
        } catch (e) {
          error = (e as Error).message;
        }
      }
      if (done) d.db.update(messages).set({ unsubscribedAt: d.now() }).where(eq(messages.id, m.id)).run();
      d.bus.publish(user.id, { type: "address.updated", address_id: m.addressId });
      return c.json({ done, error, url: done ? null : m.unsubscribeUrl, mailto: done ? null : m.unsubscribeMailto, blocked: body.block });
    },
  );

  // --- Leak history: which sender domains wrote to which addresses ------------------------------
  r.add({ method: "get", path: "/v1/leaks", summary: "Leak history grouped by sender domain (newest first)", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const user = c.get("user")!;
    const rows = d.db
      .select({ e: leakEvents, a: addresses, domain: domains.name })
      .from(leakEvents)
      .innerJoin(addresses, eq(addresses.id, leakEvents.addressId))
      .innerJoin(domains, eq(domains.id, addresses.domainId))
      .where(eq(leakEvents.userId, user.id))
      .orderBy(desc(leakEvents.at))
      .limit(2000)
      .all();
    const groups = new Map<string, { sender_domain: string; count: number; first_at: number; last_at: number; senders: Set<string>; addresses: Map<string, ReturnType<typeof addressOut>> }>();
    for (const { e, a, domain } of rows) {
      const g = groups.get(e.senderDomain) ?? { sender_domain: e.senderDomain, count: 0, first_at: e.at, last_at: e.at, senders: new Set(), addresses: new Map() };
      g.count++;
      g.first_at = Math.min(g.first_at, e.at);
      g.last_at = Math.max(g.last_at, e.at);
      g.senders.add(e.sender);
      if (!g.addresses.has(a.id)) g.addresses.set(a.id, addressOut(a, domain));
      groups.set(e.senderDomain, g);
    }
    return c.json({
      leaks: [...groups.values()]
        .sort((x, y) => y.last_at - x.last_at)
        .map((g) => ({ ...g, senders: [...g.senders], addresses: [...g.addresses.values()] })),
    });
  });

  r.add(
    {
      method: "post",
      path: "/v1/leaks/block",
      summary: "Block a sender domain on every address it wrote to",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ sender_domain: z.string().trim().toLowerCase().min(3).max(255) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const ids = d.db.selectDistinct({ id: leakEvents.addressId }).from(leakEvents).where(and(eq(leakEvents.userId, user.id), eq(leakEvents.senderDomain, body.sender_domain))).all().map((x) => x.id);
      for (const id of ids) {
        const a = d.db.select().from(addresses).where(and(eq(addresses.id, id), eq(addresses.userId, user.id))).get();
        if (!a) continue;
        const list = new Set(parseList(a.blockedSendersJson));
        list.add(body.sender_domain);
        const clear = a.leakSender && baseDomain(senderDomain(a.leakSender) ?? "") === body.sender_domain;
        d.db.update(addresses).set({ blockedSendersJson: JSON.stringify([...list].sort()), ...(clear ? { leakSender: null, leakAt: null } : {}), updatedAt: d.now() }).where(eq(addresses.id, id)).run();
        d.bus.publish(user.id, { type: "address.updated", address_id: id });
      }
      return c.json({ affected: ids.length });
    },
  );

  // --- Weekly summary --------------------------------------------------------------------------
  r.add(
    {
      method: "get",
      path: "/v1/digest",
      summary: "Summary of the last `days` days: new addresses, busiest addresses, leaks, silent addresses",
      tags: ["addresses"],
      auth: "user",
      query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const since = d.now() - query.days * DAY;
      const base = and(eq(addresses.userId, user.id), eq(addresses.isUnassigned, false), ne(addresses.status, "archived"));
      const list = (where: ReturnType<typeof and>, order = desc(addresses.createdAt)) =>
        d.db.select({ a: addresses, domain: domains.name }).from(addresses).innerJoin(domains, eq(domains.id, addresses.domainId)).where(where).orderBy(order).limit(20).all().map((x) => addressOut(x.a, x.domain));
      const busiest = d.db
        .select({ id: messages.addressId, n: sql<number>`count(*)` })
        .from(messages)
        .where(and(eq(messages.userId, user.id), gte(messages.receivedAt, since)))
        .groupBy(messages.addressId)
        .orderBy(desc(sql`count(*)`))
        .limit(5)
        .all();
      const busyRows = busiest.length
        ? new Map(d.db.select({ a: addresses, domain: domains.name }).from(addresses).innerJoin(domains, eq(domains.id, addresses.domainId)).where(inArray(addresses.id, busiest.map((b) => b.id))).all().map((x) => [x.a.id, x]))
        : new Map();
      const received = d.db.select({ n: sql<number>`count(*)` }).from(messages).where(and(eq(messages.userId, user.id), gte(messages.receivedAt, since))).get()!.n;
      return c.json({
        days: query.days,
        since,
        received,
        created: list(and(base, gte(addresses.createdAt, since))),
        busiest: busiest.filter((b) => busyRows.has(b.id)).map((b) => ({ address: addressOut(busyRows.get(b.id)!.a, busyRows.get(b.id)!.domain), count: b.n })),
        leaks: list(and(base, isNotNull(addresses.leakAt)), desc(addresses.leakAt)),
        silent: list(and(base, isNull(addresses.lastMessageAt), sql`${addresses.createdAt} < ${d.now() - 30 * DAY}`, eq(addresses.pinned, false)), asc(addresses.createdAt)),
      });
    },
  );

  // --- Export / import -------------------------------------------------------------------------
  r.add({ method: "get", path: "/v1/export", summary: "Export own categories and addresses as JSON (no messages)", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const user = c.get("user")!;
    const cats = d.db.select().from(categories).where(eq(categories.userId, user.id)).orderBy(asc(categories.position)).all();
    const catName = new Map(cats.map((x) => [x.id, x.name]));
    const rows = d.db.select({ a: addresses, domain: domains.name }).from(addresses).innerJoin(domains, eq(domains.id, addresses.domainId)).where(and(eq(addresses.userId, user.id), eq(addresses.isUnassigned, false))).all();
    c.header("content-disposition", `attachment; filename="throwaway-mail-export.json"`);
    return c.json({
      version: 1,
      exported_at: new Date(d.now()).toISOString(),
      categories: cats.map((x) => ({ name: x.name, color: x.color, pinned: x.pinned, hidden: x.hidden, auto_match: x.autoMatch, retention_days: x.retentionDays })),
      addresses: rows.map(({ a, domain }) => ({
        email: `${a.localPart}@${domain}`,
        site_name: a.siteName,
        site_url: a.siteUrl,
        label: a.label,
        status: a.status,
        pinned: a.pinned,
        category: a.categoryId ? (catName.get(a.categoryId) ?? null) : null,
        expires_at: a.expiresAt,
        blocked_senders: parseList(a.blockedSendersJson),
        trusted_senders: parseList(a.trustedSendersJson),
        created_at: a.createdAt,
      })),
    });
  });

  const ImportCategory = z.object({
    name: z.string().trim().min(1).max(40),
    color: z.enum(CATEGORY_COLORS).catch("zinc").default("zinc"),
    pinned: z.boolean().default(false),
    hidden: z.boolean().default(false),
    auto_match: z.string().max(500).nullable().default(null),
    retention_days: z.number().int().min(1).max(3650).nullable().default(null),
  });
  const ImportAddress = z.object({
    email: z.string().trim().toLowerCase(),
    site_name: z.string().trim().min(1).max(120),
    site_url: z.string().max(500).nullable().default(null),
    label: z.string().max(120).nullable().default(null),
    status: z.enum(["active", "paused", "archived"]).default("active"),
    pinned: z.boolean().default(false),
    category: z.string().nullable().default(null),
    expires_at: z.number().int().nullable().default(null),
    blocked_senders: z.array(z.string()).default([]),
    trusted_senders: z.array(z.string()).default([]),
  });

  r.add(
    {
      method: "post",
      path: "/v1/import",
      summary: "Import categories and addresses from an export (existing ones are skipped)",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ categories: z.array(ImportCategory).max(500).default([]), addresses: z.array(ImportAddress).max(10_000).default([]) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const now = d.now();
      const result = { categories_created: 0, addresses_created: 0, skipped: [] as Array<{ email: string; reason: string }> };
      d.db.transaction((tx) => {
        const byName = new Map(tx.select().from(categories).where(eq(categories.userId, user.id)).all().map((x) => [x.name, x.id]));
        let pos = tx.select({ p: sql<number>`coalesce(max(${categories.position}), -1)` }).from(categories).where(eq(categories.userId, user.id)).get()!.p;
        for (const cat of body.categories) {
          if (byName.has(cat.name)) continue;
          const id = newId("cat");
          tx.insert(categories).values({ id, userId: user.id, name: cat.name, color: cat.color, pinned: cat.pinned, hidden: cat.hidden, autoMatch: cat.auto_match, retentionDays: cat.retention_days, position: ++pos, createdAt: now }).run();
          byName.set(cat.name, id);
          result.categories_created++;
        }
        const doms = new Map(tx.select().from(domains).all().map((x) => [x.name, x]));
        for (const a of body.addresses) {
          const [local, dom] = a.email.split("@");
          const domain = dom ? doms.get(dom) : undefined;
          if (!local || !domain || domain.status !== "active" || !LOCAL_PART_RE.test(local)) {
            result.skipped.push({ email: a.email, reason: domain ? "invalid address" : "unknown domain" });
            continue;
          }
          const res = tx
            .insert(addresses)
            .values({
              id: newId("adr"),
              userId: user.id,
              domainId: domain.id,
              localPart: local,
              siteName: a.site_name,
              siteUrl: a.site_url,
              label: a.label,
              status: a.status,
              pinned: a.pinned,
              categoryId: a.category ? (byName.get(a.category) ?? null) : null,
              expiresAt: a.expires_at,
              blockedSendersJson: a.blocked_senders.length ? JSON.stringify(a.blocked_senders) : null,
              trustedSendersJson: a.trusted_senders.length ? JSON.stringify(a.trusted_senders) : null,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing()
            .run();
          if (res.changes) result.addresses_created++;
          else result.skipped.push({ email: a.email, reason: "already exists" });
        }
      });
      d.bus.publish(user.id, { type: "category.changed" });
      d.bus.publish(user.id, { type: "address.created", address_id: "" });
      return c.json(result);
    },
  );
}
