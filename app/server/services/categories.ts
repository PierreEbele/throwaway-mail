import { and, asc, eq, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import { categories, type Category, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";

export const CATEGORY_COLORS = ["zinc", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"] as const;

export const categoryOut = (c: Category, count = 0, unread = 0) => ({
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

/**
 * Category id for `name` (case-insensitive). With `create`, a missing category is created (zinc, unpinned);
 * otherwise an unknown name is a 400.
 */
export function categoryByName(d: Deps, user: User, name: string, create: boolean): string {
  const wanted = name.trim();
  if (!wanted || wanted.length > 40) throw badRequest("category must be 1–40 characters");
  const existing = d.db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, user.id), sql`lower(${categories.name}) = ${wanted.toLowerCase()}`))
    .get();
  if (existing) return existing.id;
  if (!create) throw badRequest(`Unknown category ${wanted} (pass create_category: true to create it)`);
  const max = d.db.select({ p: sql<number>`coalesce(max(${categories.position}), -1)` }).from(categories).where(eq(categories.userId, user.id)).get()!.p;
  const id = newId("cat");
  d.db.insert(categories).values({ id, userId: user.id, name: wanted, color: "zinc", pinned: false, position: max + 1, createdAt: d.now() }).run();
  d.bus.publish(user.id, { type: "category.changed" });
  return id;
}
