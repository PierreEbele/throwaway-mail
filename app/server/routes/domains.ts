import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { addresses, categories, domainMailboxes, domains, messages, users, type Domain } from "../db/schema.js";
import type { Deps } from "../context.js";
import { newId } from "../lib/crypto.js";
import { DOMAIN_RE } from "../lib/email.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { categoryByName } from "../services/categories.js";
import { checkDomain, restoreCatchAll } from "../services/domains.js";
import { domainOut } from "../services/serialize.js";
import { getMailbox, mailboxInput, mailboxOut, mailboxValues } from "../services/mailbox/settings.js";

function ownerOf(d: Deps, dom: Domain) {
  return dom.createdBy ? (d.db.select().from(users).where(eq(users.id, dom.createdBy)).get() ?? null) : null;
}
function full(d: Deps, dom: Domain) {
  const mailbox = dom.transport === "imap" ? getMailbox(d, dom.id) : null;
  const category = dom.autoCreateCategoryId
    ? (d.db.select({ name: categories.name }).from(categories).where(eq(categories.id, dom.autoCreateCategoryId)).get()?.name ?? null)
    : null;
  return {
    ...domainOut(dom, true, ownerOf(d, dom)),
    auto_create_category: category,
    ...(mailbox ? { mailbox: mailboxOut(mailbox) } : {}),
  };
}

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

const autoCreateFields = {
  auto_create_user_id: z.string().nullable().optional().describe("auto_create: owner of created addresses (null: the domain owner)"),
  auto_create_category: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional()
    .describe("auto_create: category name for created addresses, created for that user if missing (null/empty: matched from the sender)"),
};

/** Validates the auto-create settings; returns the column values to store. */
function autoCreateValues(
  d: Deps,
  body: { auto_create_user_id?: string | null; auto_create_category?: string | null },
  current: { userId: string | null; ownerId: string | null; categoryId: string | null },
) {
  const set: { autoCreateUserId?: string | null; autoCreateCategoryId?: string | null } = {};
  let userId = current.userId;
  if (body.auto_create_user_id !== undefined) {
    if (body.auto_create_user_id && !d.db.select().from(users).where(eq(users.id, body.auto_create_user_id)).get())
      throw badRequest("Unknown auto_create_user_id");
    userId = set.autoCreateUserId = body.auto_create_user_id || null;
    // The category belongs to a user: changing the user without naming a category resets it.
    if (body.auto_create_category === undefined && userId !== current.userId) set.autoCreateCategoryId = null;
  }
  if (body.auto_create_category !== undefined) {
    const effective = userId ?? current.ownerId;
    const user = effective ? d.db.select().from(users).where(eq(users.id, effective)).get() : undefined;
    if (body.auto_create_category && !user) throw badRequest("The domain has no owner to create the category for");
    set.autoCreateCategoryId = body.auto_create_category ? categoryByName(d, user!, body.auto_create_category, true) : null;
  }
  return set;
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
      summary: "Add a domain: Cloudflare Email Routing, or an IMAP/SMTP catch-all mailbox",
      tags: ["domains"],
      auth: "admin",
      body: z.object({
        name: z.string().trim().toLowerCase().regex(DOMAIN_RE, "Not a valid domain name"),
        unknown_policy: z.enum(["reject", "inbox", "auto_create"]).default("reject"),
        owner_id: z.string().optional(),
        transport: z.enum(["cloudflare", "imap"]).default("cloudflare"),
        mailbox: mailboxInput.optional(),
        ...autoCreateFields,
      }),
      description:
        'owner_id: user who receives the domain\'s "To sort" box (default: you). transport "imap" needs `mailbox` (passwords are write-only and stored encrypted with APP_SECRET); the domain becomes active once the connection test passes.',
      responses: { 201: "Domain created (status reflects the Cloudflare setup or connection test result)" },
    },
    async (c, { body }) => {
      const d = c.get("deps");
      if (d.db.select().from(domains).where(eq(domains.name, body.name)).get()) throw conflict(`${body.name} already exists`);
      if (body.owner_id && !d.db.select().from(users).where(eq(users.id, body.owner_id)).get()) throw badRequest("Unknown owner_id");
      if (body.transport === "imap" && !body.mailbox) throw badRequest("mailbox settings are required for an IMAP domain");
      const row = {
        id: newId("dom"),
        name: body.name,
        transport: body.transport,
        unknownPolicy: body.unknown_policy,
        createdBy: body.owner_id ?? c.get("user")!.id,
        createdAt: d.now(),
      };
      Object.assign(row, autoCreateValues(d, body, { userId: null, ownerId: row.createdBy, categoryId: null }));
      const mailbox = body.transport === "imap" ? mailboxValues(d, body.mailbox!) : null;
      d.db.transaction((tx) => {
        tx.insert(domains).values(row).run();
        if (mailbox)
          tx.insert(domainMailboxes)
            .values({ domainId: row.id, ...mailbox })
            .run();
      });
      audit(d, row.createdBy, "domain.added", row.id, { name: row.name, transport: row.transport }, clientIp(c));
      const result = await checkDomain(d, d.db.select().from(domains).where(eq(domains.id, row.id)).get()!);
      d.mailboxes.sync();
      return c.json({ domain: full(d, result) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/domains/:id",
      summary: "Change the unknown-recipient policy, catch-all forwarding, owner or mailbox settings",
      tags: ["domains"],
      auth: "admin",
      description:
        "forward_unknown=false stops forwarding unknown addresses to the preserved catch-all destination (unknown_policy then applies); true resumes it. mailbox (IMAP domains): new settings, empty passwords keep the stored ones; the connection is tested again.",
      body: z.object({
        unknown_policy: z.enum(["reject", "inbox", "auto_create"]).optional(),
        forward_unknown: z.boolean().optional(),
        owner_id: z.string().optional(),
        mailbox: mailboxInput.optional(),
        ...autoCreateFields,
      }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const id = c.req.param("id")!;
      const dom = d.db.select().from(domains).where(eq(domains.id, id)).get();
      if (!dom) throw notFound("Domain");
      const set: Partial<typeof dom> = {};
      if (body.unknown_policy) set.unknownPolicy = body.unknown_policy;
      Object.assign(
        set,
        autoCreateValues(d, body, {
          userId: dom.autoCreateUserId,
          ownerId: body.owner_id ?? dom.createdBy,
          categoryId: dom.autoCreateCategoryId,
        }),
      );
      if (body.forward_unknown !== undefined) {
        const previous = dom.previousCatchAllJson
          ? (JSON.parse(dom.previousCatchAllJson) as { actions: Array<{ type: string; value?: string[] }> })
          : null;
        const fwd = previous?.actions.find((a) => a.type === "forward")?.value?.[0] ?? null;
        if (body.forward_unknown && !fwd) throw badRequest("This domain had no forwarding catch-all before the app");
        set.catchallForwardTo = body.forward_unknown ? fwd : null;
      }
      if (Object.keys(set).length) d.db.update(domains).set(set).where(eq(domains.id, id)).run();
      if (body.mailbox) {
        if (dom.transport !== "imap") throw badRequest("Only IMAP domains have mailbox settings");
        const current = getMailbox(d, id);
        const values = mailboxValues(d, body.mailbox, current ?? undefined);
        // Another server or folder: its UIDs are unrelated to the ones processed so far.
        const moved =
          !current ||
          current.imapHost !== values.imapHost ||
          current.imapUser !== values.imapUser ||
          current.imapFolder !== values.imapFolder;
        const cursor = moved ? { lastUid: 0, uidValidity: null } : {};
        if (current)
          d.db
            .update(domainMailboxes)
            .set({ ...values, ...cursor })
            .where(eq(domainMailboxes.domainId, id))
            .run();
        else
          d.db
            .insert(domainMailboxes)
            .values({ domainId: id, ...values })
            .run();
        await checkDomain(d, d.db.select().from(domains).where(eq(domains.id, id)).get()!);
        d.mailboxes.sync();
      }
      if (body.owner_id && body.owner_id !== dom.createdBy) {
        if (!d.db.select().from(users).where(eq(users.id, body.owner_id)).get()) throw badRequest("Unknown owner_id");
        transferDomain(d, dom, body.owner_id);
        audit(d, c.get("user")!.id, "domain.owner_changed", id, { from: dom.createdBy, to: body.owner_id }, clientIp(c));
      }
      const { mailbox, ...changes } = body;
      audit(d, c.get("user")!.id, "domain.policy_changed", id, { ...changes, ...(mailbox ? { mailbox: "updated" } : {}) }, clientIp(c));
      return c.json({ domain: full(d, d.db.select().from(domains).where(eq(domains.id, id)).get()!) });
    },
  );

  const recheck = (path: string, summary: string) =>
    r.add({ method: "post", path, summary, tags: ["domains"], auth: "admin" }, async (c) => {
      const d = c.get("deps");
      const dom = d.db
        .select()
        .from(domains)
        .where(eq(domains.id, c.req.param("id")!))
        .get();
      if (!dom) throw notFound("Domain");
      const result = await checkDomain(d, dom);
      audit(d, c.get("user")!.id, "domain.verified", dom.id, { status: result.status }, clientIp(c));
      return c.json({ domain: full(d, result) });
    });
  recheck("/v1/domains/:id/verify", "Re-check the domain: re-apply the Cloudflare configuration, or test the IMAP/SMTP connection");
  recheck("/v1/domains/:id/test", "Test the IMAP/SMTP connection of a mailbox domain (same as /verify)");

  r.add(
    {
      method: "delete",
      path: "/v1/domains/:id",
      summary: "Remove a domain that has no addresses (restores the Cloudflare catch-all it had before the app, stops IMAP polling)",
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
      d.mailboxes.sync();
      audit(d, c.get("user")!.id, "domain.deleted", id, { name: dom.name, catch_all_restored: restored }, clientIp(c));
      return c.json({ ok: true, catch_all_restored: restored });
    },
  );
}
