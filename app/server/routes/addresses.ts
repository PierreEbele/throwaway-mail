import { and, desc, eq, gt, isNotNull, inArray, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addressDestinations, addresses, categories, domains, extractedItems, messages, type Address } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { addressOut } from "../services/serialize.js";
import { categoryByName, checkCategory } from "../services/categories.js";
import { domainOf, repliesUnavailableReason } from "../services/replies.js";
import { noMailWarning } from "../services/sites.js";
import { addressWithCounts, checkDestination, createAddress, messageCounts, ownedAddress } from "../services/addresses.js";

const SiteUrl = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v))
  .pipe(z.union([z.literal(""), z.string().url()]))
  .transform((v) => v || null);

const ExpiresAt = z
  .union([z.number().int().positive(), z.string().datetime({ offset: true }), z.null()])
  .transform((v) => (typeof v === "string" ? Date.parse(v) : v));

export function registerAddresses(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/addresses",
      summary: "Create an address for a site",
      description:
        "The local part defaults to a readable random string (word-word-1234). `domain` is a domain name or id. Without it, the domain follows the user's domain choice (first, random, rotate) and skips domains the site is known to reject (`avoided_domains` in the response).",
      tags: ["addresses"],
      auth: "user",
      body: z.object({
        domain: z.string().trim().toLowerCase().optional(),
        preferred_domain: z
          .string()
          .trim()
          .toLowerCase()
          .optional()
          .describe("Domain to use when `domain` is not given, unless the site is known to reject it"),
        domain_choice: z
          .enum(["first", "random", "rotate"])
          .optional()
          .describe("Overrides the user's domain choice for this address, when `domain` is not given"),
        site_name: z.string().trim().min(1).max(120),
        site_url: SiteUrl.optional(),
        local_part: z.string().trim().toLowerCase().optional(),
        label: z.string().trim().max(120).optional(),
        forward: z.boolean().optional(),
        destination_id: z.string().optional(),
        category_id: z.string().nullable().optional(),
        category: z.string().optional().describe("Category name (case-insensitive), instead of category_id"),
        create_category: z.boolean().default(false).describe("Create `category` if it does not exist yet"),
        expires_at: ExpiresAt.optional(),
        expires_in_days: z.number().int().min(1).max(3650).optional(),
        max_messages: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .nullable()
          .optional()
          .describe("Pause the address automatically after this many mails"),
      }),
      responses: { 201: "Created: { id, email, address }" },
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      if (body.category !== undefined && body.category_id !== undefined) throw badRequest("Pass category or category_id, not both");
      const { category, create_category, ...rest } = body;
      const category_id = category !== undefined ? categoryByName(d, user, category, create_category) : rest.category_id;
      const { a, domain, avoided } = createAddress(d, user, { ...rest, category_id });
      const o = addressWithCounts(d, a, domain);
      return c.json({ id: a.id, email: o.email, address: o, avoided_domains: avoided }, 201);
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
        unread: z.enum(["true"]).optional().describe("Only addresses with unread mail"),
        has_code: z.enum(["true"]).optional().describe("Only addresses that received a verification code"),
        since_hours: z.coerce
          .number()
          .int()
          .min(1)
          .max(24 * 365)
          .optional()
          .describe("Only addresses that received mail in the last N hours"),
        leak: z.enum(["true"]).optional().describe("Only addresses with a leak warning"),
        hide_hidden: z.enum(["true", "false"]).optional().describe("Exclude addresses whose category is hidden (used by the Inbox)"),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const conds: SQL[] = [eq(addresses.userId, user.id), eq(addresses.isUnassigned, false)];
      const scoped = c.get("apiScope")?.addressIds;
      if (scoped) conds.push(inArray(addresses.id, [...scoped]));
      if (query.status && query.status !== "all") conds.push(eq(addresses.status, query.status));
      else if (!query.status) conds.push(ne(addresses.status, "archived"));
      if (query.domain) conds.push(eq(domains.name, query.domain.toLowerCase()));
      if (query.category === "none") conds.push(isNull(addresses.categoryId));
      else if (query.category) conds.push(eq(addresses.categoryId, query.category));
      if (query.pinned) conds.push(eq(addresses.pinned, query.pinned === "true"));
      if (query.unread)
        conds.push(
          sql`exists (select 1 from ${messages} where ${messages.addressId} = ${addresses.id} and ${messages.readAt} is null and ${messages.archivedAt} is null)`,
        );
      if (query.has_code) {
        const since = query.since_hours ? d.now() - query.since_hours * 3600_000 : 0;
        conds.push(
          sql`exists (select 1 from ${messages} join ${extractedItems} on ${extractedItems.messageId} = ${messages.id} where ${messages.addressId} = ${addresses.id} and ${extractedItems.kind} = 'code' and ${extractedItems.rank} = 0 and ${messages.receivedAt} >= ${since})`,
        );
      }
      if (query.since_hours) conds.push(gt(addresses.lastMessageAt, d.now() - query.since_hours * 3600_000));
      if (query.leak) conds.push(isNotNull(addresses.leakAt));
      if (query.hide_hidden === "true") {
        conds.push(
          sql`(${addresses.categoryId} is null or not exists (select 1 from ${categories} where ${categories.id} = ${addresses.categoryId} and ${categories.hidden} = 1))`,
        );
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
      const cnt = messageCounts(
        d,
        rows.map((x) => x.a.id),
      );
      const now = d.now();
      return c.json({
        addresses: rows.map((x) => ({
          ...addressOut(x.a, x.domain, cnt.get(x.a.id)),
          no_mail_warning: noMailWarning(x.a, cnt.get(x.a.id)?.total ?? 0, now, user.noMailWarnMinutes),
        })),
      });
    },
  );

  r.add({ method: "get", path: "/v1/addresses/:id", summary: "Get one address", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const { a, domain } = ownedAddress(d, c.get("user")!, c.req.param("id")!);
    return c.json({ address: addressWithCounts(d, a, domain) });
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
        extra_destination_ids: z.array(z.string()).max(10).optional().describe("Additional destinations (replaces the list)"),
        status: z.enum(["active", "paused", "archived"]).optional(),
        expires_at: ExpiresAt.optional(),
        category_id: z.string().nullable().optional(),
        category: z.string().optional().describe("Category name, instead of category_id"),
        create_category: z.boolean().default(false),
        pinned: z.boolean().optional(),
        block_promos: z.boolean().optional(),
        site_lock: z.boolean().optional(),
        max_messages: z.number().int().min(1).max(100_000).nullable().optional(),
        burn_after_code: z.boolean().optional(),
        replies_enabled: z
          .boolean()
          .optional()
          .describe("Reverse-alias replies: forwarded mail gets a Reply-To that sends replies from the alias (needs outbound SMTP)"),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a, domain } = ownedAddress(d, user, c.req.param("id")!);
      if (body.replies_enabled) {
        const why = repliesUnavailableReason(d, domainOf(d, a));
        if (why) throw badRequest(why);
      }
      checkDestination(d, user, body.destination_id);
      for (const id of body.extra_destination_ids ?? []) checkDestination(d, user, id);
      if (body.category !== undefined && body.category_id !== undefined) throw badRequest("Pass category or category_id, not both");
      if (body.category !== undefined) body.category_id = categoryByName(d, user, body.category, body.create_category);
      checkCategory(d, user, body.category_id);
      if (body.extra_destination_ids) {
        d.db.delete(addressDestinations).where(eq(addressDestinations.addressId, a.id)).run();
        const ids = [...new Set(body.extra_destination_ids)];
        if (ids.length)
          d.db
            .insert(addressDestinations)
            .values(ids.map((destinationId) => ({ addressId: a.id, destinationId })))
            .run();
      }
      const set: Partial<Address> = { updatedAt: d.now() };
      if (body.category_id !== undefined) set.categoryId = body.category_id;
      if (body.pinned !== undefined) set.pinned = body.pinned;
      if (body.block_promos !== undefined) set.blockPromos = body.block_promos;
      if (body.site_lock !== undefined) set.siteLock = body.site_lock;
      if (body.max_messages !== undefined) set.maxMessages = body.max_messages;
      if (body.burn_after_code !== undefined) set.burnAfterCode = body.burn_after_code;
      if (body.replies_enabled !== undefined) set.repliesEnabled = body.replies_enabled;
      if (body.status === "active") Object.assign(set, { burnReason: null, burnedAt: null });
      if (body.site_name !== undefined) set.siteName = body.site_name;
      if (body.site_url !== undefined) set.siteUrl = body.site_url;
      if (body.label !== undefined) set.label = body.label || null;
      if (body.forward_enabled !== undefined) set.forwardEnabled = body.forward_enabled;
      if (body.destination_id !== undefined) set.destinationId = body.destination_id;
      if (body.status !== undefined) set.status = body.status;
      if (body.expires_at !== undefined) Object.assign(set, { expiresAt: body.expires_at, expiryRemindedAt: null });
      d.db
        .update(addresses)
        .set(set)
        .where(and(eq(addresses.id, a.id), eq(addresses.userId, user.id)))
        .run();
      d.bus.publish(user.id, { type: "address.updated", address_id: a.id });
      return c.json({ address: addressWithCounts(d, d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain) });
    },
  );

  r.add(
    { method: "delete", path: "/v1/addresses/:id", summary: "Delete an address and all its messages", tags: ["addresses"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a } = ownedAddress(d, user, c.req.param("id")!);
      d.db
        .delete(addresses)
        .where(and(eq(addresses.id, a.id), eq(addresses.userId, user.id)))
        .run();
      d.bus.publish(user.id, { type: "address.deleted", address_id: a.id });
      return c.json({ ok: true });
    },
  );
}
