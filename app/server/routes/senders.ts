import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, domains, leakEvents, type Address } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { baseDomain, parseList, senderDomain } from "../lib/senders.js";
import { addressOut } from "../services/serialize.js";
import { ownedAddress } from "../services/addresses.js";

/** Sender rules (block / trust) and leak history. */
export function registerSenders(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/senders",
      summary: "Block or trust a sender domain for an address, or dismiss its leak warning",
      description:
        "block: mail from this domain is rejected. trust: no leak warning for it. unblock/untrust undo. dismiss: clear the leak warning only.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({
        action: z.enum(["block", "unblock", "trust", "untrust", "dismiss"]),
        sender: z.string().trim().toLowerCase().max(255).optional(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a, domain } = ownedAddress(d, user, c.req.param("id")!);
      const raw = body.sender ?? a.leakSender ?? "";
      const dom = raw.includes("@") ? senderDomain(raw) : raw;
      const set: Partial<Address> = { updatedAt: d.now() };
      if (body.action !== "dismiss") {
        if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) throw badRequest("sender must be a domain or an e-mail address");
        const key = baseDomain(dom);
        const field = body.action.endsWith("block") ? "blockedSendersJson" : "trustedSendersJson";
        const list = new Set(parseList(a[field]));
        if (body.action === "block" || body.action === "trust") list.add(key);
        else list.delete(key);
        set[field] = list.size ? JSON.stringify([...list].sort()) : null;
      }
      if (body.action === "dismiss" || body.action === "trust" || body.action === "block")
        Object.assign(set, { leakSender: null, leakAt: null });
      d.db.update(addresses).set(set).where(eq(addresses.id, a.id)).run();
      d.bus.publish(user.id, { type: "address.updated", address_id: a.id });
      return c.json({ address: addressOut(d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain) });
    },
  );

  // --- Leak history: which sender domains wrote to which addresses ------------------------------
  r.add(
    {
      method: "get",
      path: "/v1/leaks",
      summary: "Leak history grouped by sender domain (newest first)",
      tags: ["addresses"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const rows = d.db
        .select({ e: leakEvents, a: addresses, domain: domains.name })
        .from(leakEvents)
        .innerJoin(addresses, eq(addresses.id, leakEvents.addressId))
        .innerJoin(domains, eq(domains.id, addresses.domainId))
        .where(eq(leakEvents.userId, user.id))
        .orderBy(desc(leakEvents.at))
        .limit(2000)
        .all();
      const groups = new Map<
        string,
        {
          sender_domain: string;
          count: number;
          first_at: number;
          last_at: number;
          senders: Set<string>;
          addresses: Map<string, ReturnType<typeof addressOut>>;
        }
      >();
      for (const { e, a, domain } of rows) {
        const g = groups.get(e.senderDomain) ?? {
          sender_domain: e.senderDomain,
          count: 0,
          first_at: e.at,
          last_at: e.at,
          senders: new Set(),
          addresses: new Map(),
        };
        g.count++;
        g.first_at = Math.min(g.first_at, e.at);
        g.last_at = Math.max(g.last_at, e.at);
        g.senders.add(e.sender);
        if (!g.addresses.has(a.id)) g.addresses.set(a.id, addressOut(a, domain));
        groups.set(e.senderDomain, g);
      }
      return c.json({
        leaks: [...groups.values()]
          .sort((x, y) => y.last_at - x.last_at)
          .map((g) => ({ ...g, senders: [...g.senders], addresses: [...g.addresses.values()] })),
      });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/leaks/block",
      summary: "Block a sender domain on every address it wrote to",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ sender_domain: z.string().trim().toLowerCase().min(3).max(255) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const ids = d.db
        .selectDistinct({ id: leakEvents.addressId })
        .from(leakEvents)
        .where(and(eq(leakEvents.userId, user.id), eq(leakEvents.senderDomain, body.sender_domain)))
        .all()
        .map((x) => x.id);
      for (const id of ids) {
        const a = d.db
          .select()
          .from(addresses)
          .where(and(eq(addresses.id, id), eq(addresses.userId, user.id)))
          .get();
        if (!a) continue;
        const list = new Set(parseList(a.blockedSendersJson));
        list.add(body.sender_domain);
        const clear = a.leakSender && baseDomain(senderDomain(a.leakSender) ?? "") === body.sender_domain;
        d.db
          .update(addresses)
          .set({
            blockedSendersJson: JSON.stringify([...list].sort()),
            ...(clear ? { leakSender: null, leakAt: null } : {}),
            updatedAt: d.now(),
          })
          .where(eq(addresses.id, id))
          .run();
        d.bus.publish(user.id, { type: "address.updated", address_id: id });
      }
      return c.json({ affected: ids.length });
    },
  );
}
