import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, categories, domains } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { LOCAL_PART_RE } from "../lib/email.js";
import { parseList } from "../lib/senders.js";
import { CATEGORY_COLORS } from "../services/categories.js";

/** Export and import of addresses and categories. */
export function registerBackup(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/export",
      summary: "Export own categories and addresses as JSON (no messages)",
      tags: ["addresses"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const cats = d.db.select().from(categories).where(eq(categories.userId, user.id)).orderBy(asc(categories.position)).all();
      const catName = new Map(cats.map((x) => [x.id, x.name]));
      const rows = d.db
        .select({ a: addresses, domain: domains.name })
        .from(addresses)
        .innerJoin(domains, eq(domains.id, addresses.domainId))
        .where(and(eq(addresses.userId, user.id), eq(addresses.isUnassigned, false)))
        .all();
      c.header("content-disposition", `attachment; filename="throwaway-mail-export.json"`);
      return c.json({
        version: 1,
        exported_at: new Date(d.now()).toISOString(),
        categories: cats.map((x) => ({
          name: x.name,
          color: x.color,
          pinned: x.pinned,
          hidden: x.hidden,
          auto_match: x.autoMatch,
          retention_days: x.retentionDays,
        })),
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
    },
  );

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
      body: z.object({
        categories: z.array(ImportCategory).max(500).default([]),
        addresses: z.array(ImportAddress).max(10_000).default([]),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const now = d.now();
      const result = { categories_created: 0, addresses_created: 0, skipped: [] as Array<{ email: string; reason: string }> };
      d.db.transaction((tx) => {
        const byName = new Map(
          tx
            .select()
            .from(categories)
            .where(eq(categories.userId, user.id))
            .all()
            .map((x) => [x.name, x.id]),
        );
        let pos = tx
          .select({ p: sql<number>`coalesce(max(${categories.position}), -1)` })
          .from(categories)
          .where(eq(categories.userId, user.id))
          .get()!.p;
        for (const cat of body.categories) {
          if (byName.has(cat.name)) continue;
          const id = newId("cat");
          tx.insert(categories)
            .values({
              id,
              userId: user.id,
              name: cat.name,
              color: cat.color,
              pinned: cat.pinned,
              hidden: cat.hidden,
              autoMatch: cat.auto_match,
              retentionDays: cat.retention_days,
              position: ++pos,
              createdAt: now,
            })
            .run();
          byName.set(cat.name, id);
          result.categories_created++;
        }
        const doms = new Map(
          tx
            .select()
            .from(domains)
            .all()
            .map((x) => [x.name, x]),
        );
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
