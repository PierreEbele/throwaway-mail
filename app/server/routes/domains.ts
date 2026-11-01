import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { addresses, domains, messages, users, type Domain } from "../db/schema.js";
import type { Deps } from "../context.js";
import { newId } from "../lib/crypto.js";
import { DOMAIN_RE } from "../lib/email.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { restoreCatchAll, setupDomain } from "../services/domains.js";
import { domainOut } from "../services/serialize.js";

function ownerOf(d: Deps, dom: Domain) {
  return dom.createdBy ? (d.db.select().from(users).where(eq(users.id, dom.createdBy)).get() ?? null) : null;
}
const full = (d: Deps, dom: Domain) => domainOut(dom, true, ownerOf(d, dom));

/** Hand a domain (and its "To sort" box with the mail in it) over to another user. */
function transferDomain(d: Deps, dom: Domain, newOwnerId: string) {
  d.db.transaction((tx) => {
    tx.update(domains).set({ createdBy: newOwnerId }).where(eq(domains.id, dom.id)).run();
    const boxes = tx
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(eq(addresses.domainId, dom.id), eq(addresses.isUnassigned, true)))
      .all();
    for (const b of boxes) {
      tx.update(addresses).set({ userId: newOwnerId }).where(eq(addresses.id, b.id)).run();
      tx.update(messages).set({ userId: newOwnerId }).where(eq(messages.addressId, b.id)).run();
    }
  });
}

export function registerDomains(r: ApiRouter) {
  r.add(
    { method: "get", path: "/v1/domains", summary: "List domains (admins also see Cloudflare details)", tags: ["domains"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      const isAdmin = c.get("user")!.role === "admin";
      const rows = d.db.select().from(domains).orderBy(asc(domains.createdAt)).all();
      return c.json({
        domains: rows.filter((x) => isAdmin || x.status === "active").map((x) => (isAdmin ? full(d, x) : domainOut(x, false))),
      });
    },
  );

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
        owner_id: z.string().optional(),
      }),
      description: 'owner_id: user who receives the domain\'s "To sort" box (default: you).',
      responses: { 201: "Domain created (status reflects the Cloudflare setup result)" },
    },
    async (c, { body }) => {
      const d = c.get("deps");
      if (d.db.select().from(domains).where(eq(domains.name, body.name)).get()) throw conflict(`${body.name} already exists`);
      if (body.owner_id && !d.db.select().from(users).where(eq(users.id, body.owner_id)).get()) throw badRequest("Unknown owner_id");
      const row = {
        id: newId("dom"),
        name: body.name,
        unknownPolicy: body.unknown_policy,
        createdBy: body.owner_id ?? c.get("user")!.id,
        createdAt: d.now(),
      };
      d.db.insert(domains).values(row).run();
      audit(d, row.createdBy, "domain.added", row.id, { name: row.name }, clientIp(c));
      const result = await setupDomain(d, d.db.select().from(domains).where(eq(domains.id, row.id)).get()!);
      return c.json({ domain: full(d, result) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/domains/:id",
      summary: "Change the unknown-recipient policy, catch-all forwarding or owner",
      tags: ["domains"],
      auth: "admin",
      description:
        "forward_unknown=false stops forwarding unknown addresses to the preserved catch-all destination (unknown_policy then applies); true resumes it.",
      body: z.object({
        unknown_policy: z.enum(["reject", "inbox", "auto_create"]).optional(),
        forward_unknown: z.boolean().optional(),
        owner_id: z.string().optional(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const id = c.req.param("id")!;
      const dom = d.db.select().from(domains).where(eq(domains.id, id)).get();
      if (!dom) throw notFound("Domain");
      const set: Partial<typeof dom> = {};
      if (body.unknown_policy) set.unknownPolicy = body.unknown_policy;
      if (body.forward_unknown !== undefined) {
        const previous = dom.previousCatchAllJson
          ? (JSON.parse(dom.previousCatchAllJson) as { actions: Array<{ type: string; value?: string[] }> })
          : null;
        const fwd = previous?.actions.find((a) => a.type === "forward")?.value?.[0] ?? null;
        if (body.forward_unknown && !fwd) throw badRequest("This domain had no forwarding catch-all before the app");
        set.catchallForwardTo = body.forward_unknown ? fwd : null;
      }
      if (Object.keys(set).length) d.db.update(domains).set(set).where(eq(domains.id, id)).run();
      if (body.owner_id && body.owner_id !== dom.createdBy) {
        if (!d.db.select().from(users).where(eq(users.id, body.owner_id)).get()) throw badRequest("Unknown owner_id");
        transferDomain(d, dom, body.owner_id);
        audit(d, c.get("user")!.id, "domain.owner_changed", id, { from: dom.createdBy, to: body.owner_id }, clientIp(c));
      }
      audit(d, c.get("user")!.id, "domain.policy_changed", id, body, clientIp(c));
      return c.json({ domain: full(d, d.db.select().from(domains).where(eq(domains.id, id)).get()!) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/domains/:id/verify",
      summary: "Re-check / re-apply the Cloudflare configuration",
      tags: ["domains"],
      auth: "admin",
    },
    async (c) => {
      const d = c.get("deps");
      const dom = d.db
        .select()
        .from(domains)
        .where(eq(domains.id, c.req.param("id")!))
        .get();
      if (!dom) throw notFound("Domain");
      const result = await setupDomain(d, dom);
      audit(d, c.get("user")!.id, "domain.verified", dom.id, { status: result.status }, clientIp(c));
      return c.json({ domain: full(d, result) });
    },
  );

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
