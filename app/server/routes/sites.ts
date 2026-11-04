import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { domains, siteRejections, users } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { addressOut, userOut } from "../services/serialize.js";
import { ownedAddress, replaceAddress } from "../services/addresses.js";
import { pickDomain, recordRejection, rejectionStats } from "../services/sites.js";

/** Sites that reject alias domains: reports, per-site domain memory, domain choice preferences. */
export function registerSites(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/rejected",
      summary: "Report that the address's site rejected its domain; optionally replace it with one on another domain",
      description:
        "Records (site, domain) so new addresses for this site avoid the domain. With `replace` (default), a new address is created on another active domain (copying site, category, forwarding and protections) and the old one is paused. Fails with 400 when there is no other domain; the report is kept.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ replace: z.boolean().default(true), archive_old: z.boolean().default(false) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a: old } = ownedAddress(d, user, c.req.param("id")!);
      const rej = recordRejection(d, user, old);
      d.bus.publish(user.id, { type: "address.updated", address_id: old.id });
      const others = d.db
        .select({ id: domains.id })
        .from(domains)
        .where(eq(domains.status, "active"))
        .all()
        .filter((x) => x.id !== old.domainId);
      const rejection = { id: rej.id, site: rej.site, domain_id: rej.domainId };
      if (!body.replace) return c.json({ rejection, address: null, other_domains: others.length });
      if (!others.length) throw badRequest("No other active domain to move this address to. Add another domain first.");
      const { a, domain } = replaceAddress(d, user, old, { archive_old: body.archive_old, exclude_domain_ids: [old.domainId] });
      return c.json({ rejection, address: addressOut(a, domain), replaced_id: old.id, other_domains: others.length }, 201);
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/site-rejections",
      summary: "Own reports of sites rejecting a domain",
      tags: ["addresses"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const rows = d.db
        .select({ r: siteRejections, domain: domains.name })
        .from(siteRejections)
        .innerJoin(domains, eq(domains.id, siteRejections.domainId))
        .where(eq(siteRejections.userId, c.get("user")!.id))
        .orderBy(desc(siteRejections.createdAt))
        .all();
      return c.json({
        rejections: rows.map((x) => ({
          id: x.r.id,
          site: x.r.site,
          domain: x.domain,
          domain_id: x.r.domainId,
          address_id: x.r.addressId,
          created_at: x.r.createdAt,
        })),
      });
    },
  );

  r.add(
    { method: "delete", path: "/v1/site-rejections/:id", summary: "Forget a rejection report", tags: ["addresses"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      const res = d.db
        .delete(siteRejections)
        .where(and(eq(siteRejections.id, c.req.param("id")!), eq(siteRejections.userId, c.get("user")!.id)))
        .run();
      if (!res.changes) throw notFound("Rejection");
      return c.json({ ok: true });
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/sites/domain",
      summary: "Domain a new address for this site would get, and the domains skipped because the site rejected them",
      tags: ["addresses"],
      auth: "user",
      query: z.object({ site_name: z.string().optional(), site_url: z.string().optional(), preferred_domain: z.string().optional() }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const pick = pickDomain(d, c.get("user")!, query, { preferred: query.preferred_domain });
      return c.json({ domain: pick.domain?.name ?? null, avoided: pick.avoided.map((x) => x.name) });
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/auth/me/preferences",
      summary: "Update own preferences: domain choice for new addresses, no-mail warning delay",
      tags: ["auth"],
      auth: "user",
      body: z.object({
        domain_choice: z.enum(["first", "random", "rotate"]).optional(),
        no_mail_warn_minutes: z
          .number()
          .int()
          .min(0)
          .max(24 * 60)
          .optional(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const set: Partial<typeof users.$inferInsert> = {};
      if (body.domain_choice !== undefined) set.domainChoice = body.domain_choice;
      if (body.no_mail_warn_minutes !== undefined) set.noMailWarnMinutes = body.no_mail_warn_minutes;
      if (Object.keys(set).length) d.db.update(users).set(set).where(eq(users.id, user.id)).run();
      return c.json({ user: userOut(d.db.select().from(users).where(eq(users.id, user.id)).get()!) });
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/admin/site-rejections",
      summary: "Which sites reject which domains (all users, aggregated)",
      tags: ["admin"],
      auth: "admin",
    },
    (c) => c.json({ rejections: rejectionStats(c.get("deps")) }),
  );
}
