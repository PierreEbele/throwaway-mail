import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, categories, messages, type Category } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { conflict } from "../lib/errors.js";
import { CATEGORY_COLORS, categoryOut, ownedCategory } from "../services/categories.js";
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
}
