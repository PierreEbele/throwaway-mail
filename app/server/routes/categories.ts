import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import type { Deps } from "../context.js";
import { addresses, categories, domains, messages, type Category, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { addressOut } from "../services/serialize.js";

export const CATEGORY_COLORS = ["zinc", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"] as const;

const categoryOut = (c: Category, count = 0, unread = 0) => ({
  id: c.id,
  name: c.name,
  color: c.color,
  pinned: c.pinned,
  hidden: c.hidden,
  auto_match: c.autoMatch,
  retention_days: c.retentionDays,
  position: c.position,
  created_at: c.createdAt,
  address_count: count,
  unread_count: unread,
});

/** First category (by position) whose keywords appear in the site name or URL. */
export function matchCategory(d: Deps, userId: string, siteName: string, siteUrl: string | null): string | null {
  const hay = `${siteName} ${siteUrl ?? ""}`.toLowerCase();
  const rows = d.db.select().from(categories).where(eq(categories.userId, userId)).orderBy(asc(categories.position)).all();
  for (const c of rows) {
    const words = (c.autoMatch ?? "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.some((w) => hay.includes(w))) return c.id;
  }
  return null;
}

export function ownedCategory(d: Deps, user: User, id: string) {
  const row = d.db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, user.id))).get();
  if (!row) throw notFound("Category");
  return row;
}

/** Throws 400 unless `id` is null/undefined or one of the user's categories. */
export function checkCategory(d: Deps, user: User, id: string | null | undefined) {
  if (!id) return;
  if (!d.db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, id), eq(categories.userId, user.id))).get()) {
    throw badRequest("Unknown category_id");
  }
}

const Name = z.string().trim().min(1).max(40);
const Color = z.enum(CATEGORY_COLORS);
const AutoMatch = z.string().trim().max(500).nullable().transform((v) => v || null);
const Retention = z.number().int().min(1).max(3650).nullable();

export function registerCategories(r: ApiRouter) {
  r.add({ method: "get", path: "/v1/categories", summary: "List own address categories (pinned first)", tags: ["categories"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const user = c.get("user")!;
    const rows = d.db.select().from(categories).where(eq(categories.userId, user.id)).orderBy(desc(categories.pinned), asc(categories.position), asc(categories.name)).all();
    const counts = new Map(
      d.db
        .select({ id: addresses.categoryId, n: sql<number>`count(*)` })
        .from(addresses)
        .where(and(eq(addresses.userId, user.id), sql`${addresses.status} != 'archived'`))
        .groupBy(addresses.categoryId)
        .all()
        .map((x) => [x.id, x.n]),
    );
    const unread = new Map(
      d.db
        .select({ id: addresses.categoryId, n: sql<number>`count(*)` })
        .from(messages)
        .innerJoin(addresses, eq(addresses.id, messages.addressId))
        .where(and(eq(messages.userId, user.id), isNull(messages.readAt), isNull(messages.archivedAt), sql`${addresses.status} != 'archived'`))
        .groupBy(addresses.categoryId)
        .all()
        .map((x) => [x.id, x.n]),
    );
    return c.json({ categories: rows.map((x) => categoryOut(x, counts.get(x.id) ?? 0, unread.get(x.id) ?? 0)) });
  });

  r.add(
    {
      method: "post",
      path: "/v1/categories",
      summary: "Create a category",
      tags: ["categories"],
      auth: "user",
      body: z.object({ name: Name, color: Color.optional(), pinned: z.boolean().optional(), auto_match: AutoMatch.optional(), retention_days: Retention.optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      if (d.db.select().from(categories).where(and(eq(categories.userId, user.id), eq(categories.name, body.name))).get()) throw conflict(`Category ${body.name} already exists`);
      const max = d.db.select({ p: sql<number>`coalesce(max(${categories.position}), -1)` }).from(categories).where(eq(categories.userId, user.id)).get()!.p;
      const row = { id: newId("cat"), userId: user.id, name: body.name, color: body.color ?? "zinc", pinned: body.pinned ?? false, autoMatch: body.auto_match ?? null, retentionDays: body.retention_days ?? null, position: max + 1, createdAt: d.now() };
      d.db.insert(categories).values(row).run();
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ category: categoryOut(d.db.select().from(categories).where(eq(categories.id, row.id)).get()!) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/categories/:id",
      summary: "Rename, recolour, pin, hide or reorder a category",
      tags: ["categories"],
      auth: "user",
      body: z.object({ name: Name.optional(), color: Color.optional(), pinned: z.boolean().optional(), hidden: z.boolean().optional(), auto_match: AutoMatch.optional(), retention_days: Retention.optional(), position: z.number().int().min(0).max(10_000).optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const cat = ownedCategory(d, user, c.req.param("id")!);
      if (body.name && body.name !== cat.name && d.db.select().from(categories).where(and(eq(categories.userId, user.id), eq(categories.name, body.name))).get()) {
        throw conflict(`Category ${body.name} already exists`);
      }
      const set: Partial<Category> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.color !== undefined) set.color = body.color;
      if (body.pinned !== undefined) set.pinned = body.pinned;
      if (body.hidden !== undefined) set.hidden = body.hidden;
      if (body.auto_match !== undefined) set.autoMatch = body.auto_match;
      if (body.retention_days !== undefined) set.retentionDays = body.retention_days;
      if (body.position !== undefined) set.position = body.position;
      if (Object.keys(set).length) d.db.update(categories).set(set).where(eq(categories.id, cat.id)).run();
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ category: categoryOut(d.db.select().from(categories).where(eq(categories.id, cat.id)).get()!) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/categories/reorder",
      summary: "Set the order of categories (ids in the new order)",
      tags: ["categories"],
      auth: "user",
      body: z.object({ ids: z.array(z.string()).min(1).max(500) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      d.db.transaction((tx) => {
        body.ids.forEach((id, i) => tx.update(categories).set({ position: i }).where(and(eq(categories.id, id), eq(categories.userId, user.id))).run());
      });
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ ok: true });
    },
  );

  r.add({ method: "delete", path: "/v1/categories/:id", summary: "Delete a category (its addresses become uncategorised)", tags: ["categories"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const user = c.get("user")!;
    const cat = ownedCategory(d, user, c.req.param("id")!);
    d.db.update(addresses).set({ categoryId: null }).where(and(eq(addresses.categoryId, cat.id), eq(addresses.userId, user.id))).run();
    d.db.delete(categories).where(eq(categories.id, cat.id)).run();
    d.bus.publish(user.id, { type: "category.changed" });
    return c.json({ ok: true });
  });

  // --- Addresses that never received any mail ---------------------------------------------------

  const staleRows = (d: Deps, user: User, days: number) =>
    d.db
      .select({ a: addresses, domain: domains.name })
      .from(addresses)
      .innerJoin(domains, eq(domains.id, addresses.domainId))
      .where(
        and(
          eq(addresses.userId, user.id),
          eq(addresses.isUnassigned, false),
          sql`${addresses.status} != 'archived'`,
          eq(addresses.pinned, false),
          isNull(addresses.lastMessageAt),
          isNull(addresses.staleDismissedAt),
          lt(addresses.createdAt, d.now() - days * 86400_000),
          sql`not exists (select 1 from ${messages} where ${messages.addressId} = ${addresses.id})`,
        ),
      )
      .orderBy(asc(addresses.createdAt))
      .all();

  r.add(
    {
      method: "get",
      path: "/v1/stale-addresses",
      summary: "Addresses that never received any mail after `days` days (pinned and dismissed ones excluded)",
      tags: ["addresses"],
      auth: "user",
      query: z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      return c.json({ days: query.days, addresses: staleRows(d, c.get("user")!, query.days).map((x) => addressOut(x.a, x.domain)) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/stale-addresses",
      summary: "Archive, delete or keep (dismiss) addresses that never received mail",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ action: z.enum(["archive", "delete", "keep"]), ids: z.array(z.string()).min(1).max(1000), days: z.number().int().min(1).max(3650).default(30) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      // Only act on addresses that are still stale: a mail may have arrived since the list was shown.
      const allowed = new Set(staleRows(d, user, body.days).map((x) => x.a.id));
      const ids = body.ids.filter((id) => allowed.has(id));
      if (ids.length) {
        const where = and(eq(addresses.userId, user.id), inArray(addresses.id, ids));
        if (body.action === "delete") d.db.delete(addresses).where(where).run();
        else if (body.action === "archive") d.db.update(addresses).set({ status: "archived", updatedAt: d.now() }).where(where).run();
        else d.db.update(addresses).set({ staleDismissedAt: d.now() }).where(where).run();
        for (const id of ids) d.bus.publish(user.id, { type: body.action === "delete" ? "address.deleted" : "address.updated", address_id: id });
      }
      return c.json({ affected: ids.length, skipped: body.ids.length - ids.length });
    },
  );
}
