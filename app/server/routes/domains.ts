import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { addresses, domains } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { DOMAIN_RE } from "../lib/email.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { restoreCatchAll, setupDomain } from "../services/domains.js";
import { domainOut } from "../services/serialize.js";

export function registerDomains(r: ApiRouter) {
  r.add({ method: "get", path: "/v1/domains", summary: "List domains (admins also see Cloudflare details)", tags: ["domains"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const isAdmin = c.get("user")!.role === "admin";
    const rows = d.db.select().from(domains).orderBy(asc(domains.createdAt)).all();
    return c.json({ domains: rows.filter((x) => isAdmin || x.status === "active").map((x) => domainOut(x, isAdmin)) });
  });

  r.add(
    {
      method: "post",
      path: "/v1/domains",
      summary: "Add a domain and configure Cloudflare Email Routing for it",
      tags: ["domains"],
      auth: "admin",
      body: z.object({
        name: z.string().trim().toLowerCase().regex(DOMAIN_RE, "Not a valid domain name"),
        unknown_policy: z.enum(["reject", "inbox", "auto_create"]).default("reject"),
      }),
      responses: { 201: "Domain created (status reflects the Cloudflare setup result)" },
    },
    async (c, { body }) => {
      const d = c.get("deps");
      if (d.db.select().from(domains).where(eq(domains.name, body.name)).get()) throw conflict(`${body.name} already exists`);
      const row = { id: newId("dom"), name: body.name, unknownPolicy: body.unknown_policy, createdBy: c.get("user")!.id, createdAt: d.now() };
      d.db.insert(domains).values(row).run();
      audit(d, row.createdBy, "domain.added", row.id, { name: row.name }, clientIp(c));
      const result = await setupDomain(d, d.db.select().from(domains).where(eq(domains.id, row.id)).get()!);
      return c.json({ domain: domainOut(result, true) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/domains/:id",
      summary: "Change the unknown-recipient policy",
      tags: ["domains"],
      auth: "admin",
      description:
        "forward_unknown=false stops forwarding unknown addresses to the preserved catch-all destination (unknown_policy then applies); true resumes it.",
      body: z.object({ unknown_policy: z.enum(["reject", "inbox", "auto_create"]).optional(), forward_unknown: z.boolean().optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const id = c.req.param("id")!;
      const dom = d.db.select().from(domains).where(eq(domains.id, id)).get();
      if (!dom) throw notFound("Domain");
      const set: Partial<typeof dom> = {};
      if (body.unknown_policy) set.unknownPolicy = body.unknown_policy;
      if (body.forward_unknown !== undefined) {
        const previous = dom.previousCatchAllJson ? (JSON.parse(dom.previousCatchAllJson) as { actions: Array<{ type: string; value?: string[] }> }) : null;
        const fwd = previous?.actions.find((a) => a.type === "forward")?.value?.[0] ?? null;
        if (body.forward_unknown && !fwd) throw badRequest("This domain had no forwarding catch-all before the app");
        set.catchallForwardTo = body.forward_unknown ? fwd : null;
      }
      if (Object.keys(set).length) d.db.update(domains).set(set).where(eq(domains.id, id)).run();
      audit(d, c.get("user")!.id, "domain.policy_changed", id, body, clientIp(c));
      return c.json({ domain: domainOut(d.db.select().from(domains).where(eq(domains.id, id)).get()!, true) });
    },
  );

  r.add({ method: "post", path: "/v1/domains/:id/verify", summary: "Re-check / re-apply the Cloudflare configuration", tags: ["domains"], auth: "admin" }, async (c) => {
    const d = c.get("deps");
    const dom = d.db.select().from(domains).where(eq(domains.id, c.req.param("id")!)).get();
    if (!dom) throw notFound("Domain");
    const result = await setupDomain(d, dom);
    audit(d, c.get("user")!.id, "domain.verified", dom.id, { status: result.status }, clientIp(c));
    return c.json({ domain: domainOut(result, true) });
  });

  r.add(
    {
      method: "delete",
      path: "/v1/domains/:id",
      summary: "Remove a domain that has no addresses (restores the catch-all it had before the app)",
      tags: ["domains"],
      auth: "admin",
    },
    async (c) => {
      const d = c.get("deps");
      const id = c.req.param("id")!;
      const dom = d.db.select().from(domains).where(eq(domains.id, id)).get();
      if (!dom) throw notFound("Domain");
      const n = d.db
        .select({ n: sql<number>`count(*)` })
        .from(addresses)
        .where(and(eq(addresses.domainId, id), eq(addresses.isUnassigned, false)))
        .get()!.n;
      if (n > 0) throw badRequest(`Domain still has ${n} address(es); delete them first`);
      let restored = false;
      try {
        restored = await restoreCatchAll(d, dom);
      } catch (e) {
        throw badRequest(`Could not restore the previous catch-all in Cloudflare, domain kept: ${(e as Error).message}`);
      }
      d.db.delete(domains).where(eq(domains.id, id)).run();
      audit(d, c.get("user")!.id, "domain.deleted", id, { name: dom.name, catch_all_restored: restored }, clientIp(c));
      return c.json({ ok: true, catch_all_restored: restored });
    },
  );
}
