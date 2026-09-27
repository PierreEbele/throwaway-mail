import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import type { Deps } from "../context.js";
import { addresses, destinations, domains, messages, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { LOCAL_PART_RE, normalizeRecipient } from "../lib/email.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { refreshDestination } from "../services/destinations.js";
import { addressOut } from "../services/serialize.js";

const SENDER_NOISE = /^(?:mail|email|e|em|mg|news|newsletter|noreply|no-reply|notifications?|notify|info|bounce|bounces|send|mailer|mx|smtp|accounts?|account|members?|hello|team|support|mkt|marketing|click|links?)\./;

/** "noreply@mail.github.com" → { siteName: "Github", siteUrl: "https://github.com" } */
export function suggestSite(senderDomain: string | null): { siteName: string; siteUrl: string | null } {
  if (!senderDomain) return { siteName: "", siteUrl: null };
  let d = senderDomain.toLowerCase();
  while (SENDER_NOISE.test(d) && d.split(".").length > 2) d = d.replace(SENDER_NOISE, "");
  const labels = d.split(".");
  const twoLevelTld = labels.length >= 3 && /^(co|com|org|net|gouv|ac)$/.test(labels[labels.length - 2]!);
  const base = labels.slice(twoLevelTld ? -3 : -2).join(".");
  const name = base.split(".")[0]!;
  return { siteName: name.charAt(0).toUpperCase() + name.slice(1), siteUrl: `https://${base}` };
}

/** The user's "To sort" boxes (one per domain they own that collects unknown recipients). */
function boxesOf(deps: Deps, user: User) {
  return deps.db
    .select({ box: addresses, domain: domains })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(and(eq(addresses.userId, user.id), eq(addresses.isUnassigned, true)))
    .all();
}

function boxFor(deps: Deps, user: User, recipient: string) {
  const r = normalizeRecipient(recipient);
  if (!r) throw badRequest("Invalid recipient");
  const hit = boxesOf(deps, user).find((b) => b.domain.name === r.domain);
  if (!hit) throw notFound("Review item");
  const n = deps.db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.addressId, hit.box.id), eq(messages.envelopeTo, r.full)))
    .get()!.n;
  if (!n) throw notFound("Review item");
  return { ...hit, rcpt: r };
}

/** Make sure the user has a destination row for this mailbox (it is already verified in Cloudflare when it was a catch-all target). */
async function ensureDestination(deps: Deps, user: User, email: string) {
  let dest = deps.db.select().from(destinations).where(and(eq(destinations.userId, user.id), eq(destinations.email, email))).get();
  if (!dest) {
    const row = { id: newId("dst"), userId: user.id, email, createdAt: deps.now() };
    deps.db.insert(destinations).values(row).run();
    dest = deps.db.select().from(destinations).where(eq(destinations.id, row.id)).get()!;
  }
  if (!dest.verifiedAt) dest = await refreshDestination(deps, dest);
  return dest;
}

export function registerReview(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/review",
      summary: "Mail received on unknown addresses, grouped by recipient, with a suggested site",
      description: "Only domain owners have review boxes. Each item can be registered as an address (its past mail moves along), blocked, or dismissed.",
      tags: ["review"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const boxes = boxesOf(d, c.get("user")!);
      if (!boxes.length) return c.json({ items: [], total: 0 });
      const boxIds = boxes.map((b) => b.box.id);
      const rows = d.db
        .select({
          addressId: messages.addressId,
          recipient: messages.envelopeTo,
          count: sql<number>`count(*)`,
          unread: sql<number>`sum(case when ${messages.readAt} is null then 1 else 0 end)`,
          first: sql<number>`min(${messages.receivedAt})`,
          last: sql<number>`max(${messages.receivedAt})`,
        })
        .from(messages)
        .where(inArray(messages.addressId, boxIds))
        .groupBy(messages.addressId, messages.envelopeTo)
        .orderBy(sql`max(${messages.receivedAt}) desc`)
        .all();
      const items = rows.map((row) => {
        const box = boxes.find((b) => b.box.id === row.addressId)!;
        const recent = d.db
          .select({ id: messages.id, from: messages.fromAddr, subject: messages.subject, receivedAt: messages.receivedAt, forwarded: messages.forwarded })
          .from(messages)
          .where(and(eq(messages.addressId, row.addressId), eq(messages.envelopeTo, row.recipient)))
          .orderBy(sql`${messages.receivedAt} desc`)
          .limit(5)
          .all();
        const senderDomains = [...new Set(recent.map((m) => m.from?.split("@")[1]?.toLowerCase()).filter((x): x is string => !!x))];
        const local = row.recipient.split("@")[0]!;
        return {
          recipient: row.recipient,
          domain: box.domain.name,
          count: row.count,
          unread: row.unread ?? 0,
          first_received_at: row.first,
          last_received_at: row.last,
          forwarded_to: box.domain.catchallForwardTo,
          sender_domains: senderDomains,
          recent: recent.map((m) => ({ id: m.id, from: m.from, subject: m.subject, received_at: m.receivedAt, forwarded: m.forwarded })),
          suggestion: suggestSite(senderDomains[0] ?? null),
          registrable: LOCAL_PART_RE.test(local),
        };
      });
      return c.json({ items, total: items.length });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/review/register",
      summary: "Register a caught recipient as an address for a site (its past mail moves to it)",
      tags: ["review"],
      auth: "user",
      body: z.object({
        recipient: z.string().trim().toLowerCase(),
        site_name: z.string().trim().min(1).max(120),
        site_url: z.string().trim().max(500).optional(),
        forward: z.boolean().optional(),
        block: z.boolean().optional(),
      }),
      responses: { 201: "{ address }" },
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { box, domain, rcpt } = boxFor(d, user, body.recipient);
      if (!LOCAL_PART_RE.test(rcpt.local)) throw badRequest(`"${rcpt.local}" cannot be used as an address name`);
      if (d.db.select().from(addresses).where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, rcpt.local))).get()) {
        throw conflict(`${rcpt.full} already exists`);
      }
      // Default: keep the behaviour the old catch-all had (forwarding to the same mailbox).
      const wantForward = !body.block && (body.forward ?? !!domain.catchallForwardTo);
      let destinationId: string | null = null;
      if (wantForward && domain.catchallForwardTo) destinationId = (await ensureDestination(d, user, domain.catchallForwardTo)).id;
      const siteUrl = body.site_url ? (/^https?:\/\//i.test(body.site_url) ? body.site_url : `https://${body.site_url}`) : null;
      const now = d.now();
      const row = {
        id: newId("adr"),
        userId: user.id,
        domainId: domain.id,
        localPart: rcpt.local,
        siteName: body.site_name,
        siteUrl,
        forwardEnabled: wantForward,
        destinationId,
        status: body.block ? ("paused" as const) : ("active" as const),
        label: body.block ? "blocked from review" : "registered from review",
        createdAt: now,
        updatedAt: now,
      };
      d.db.transaction((tx) => {
        tx.insert(addresses).values(row).run();
        tx.update(messages)
          .set({ addressId: row.id })
          .where(and(eq(messages.addressId, box.id), eq(messages.envelopeTo, rcpt.full)))
          .run();
        tx.update(addresses)
          .set({ lastMessageAt: sql`(select max(received_at) from messages where address_id = ${row.id})` })
          .where(eq(addresses.id, row.id))
          .run();
      });
      d.bus.publish(user.id, { type: "address.created", address_id: row.id });
      const a = d.db.select().from(addresses).where(eq(addresses.id, row.id)).get()!;
      return c.json({ address: addressOut(a, domain.name) }, 201);
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/review/dismiss",
      summary: "Delete the stored mail of a caught recipient (forwarding by the old catch-all is unaffected)",
      tags: ["review"],
      auth: "user",
      body: z.object({ recipient: z.string().trim().toLowerCase() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const { box, rcpt } = boxFor(d, c.get("user")!, body.recipient);
      const res = d.db
        .delete(messages)
        .where(and(eq(messages.addressId, box.id), eq(messages.envelopeTo, rcpt.full)))
        .run();
      return c.json({ ok: true, deleted: res.changes });
    },
  );

  r.add({ method: "get", path: "/v1/review/count", summary: "Number of caught recipients waiting (for the menu badge)", tags: ["review"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const ids = boxesOf(d, c.get("user")!).map((b) => b.box.id);
    if (!ids.length) return c.json({ count: 0, unread: 0 });
    const row = d.db
      .select({ count: sql<number>`count(distinct ${messages.envelopeTo})`, unread: sql<number>`count(distinct case when ${messages.readAt} is null then ${messages.envelopeTo} end)` })
      .from(messages)
      .where(inArray(messages.addressId, ids))
      .get()!;
    return c.json({ count: row.count, unread: row.unread });
  });
}
