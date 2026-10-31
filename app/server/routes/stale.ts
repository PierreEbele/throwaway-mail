import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import type { Deps } from "../context.js";
import { addresses, domains, messages, type User } from "../db/schema.js";
import { addressOut } from "../services/serialize.js";

/** Addresses that never received any mail. */
export function registerStale(r: ApiRouter) {
  const staleRows = (d: Deps, user: User, days: number) =>
    d.db
      .select({ a: addresses, domain: domains.name })
      .from(addresses)
      .innerJoin(domains, eq(domains.id, addresses.domainId))
      .where(
        and(
          eq(addresses.userId, user.id),
          eq(addresses.isUnassigned, false),
          sql`${addresses.status} != 'archived'`,
          eq(addresses.pinned, false),
          isNull(addresses.lastMessageAt),
          isNull(addresses.staleDismissedAt),
          lt(addresses.createdAt, d.now() - days * 86400_000),
          sql`not exists (select 1 from ${messages} where ${messages.addressId} = ${addresses.id})`,
        ),
      )
      .orderBy(asc(addresses.createdAt))
      .all();

  r.add(
    {
      method: "get",
      path: "/v1/stale-addresses",
      summary: "Addresses that never received any mail after `days` days (pinned and dismissed ones excluded)",
      tags: ["addresses"],
      auth: "user",
      query: z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      return c.json({ days: query.days, addresses: staleRows(d, c.get("user")!, query.days).map((x) => addressOut(x.a, x.domain)) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/stale-addresses",
      summary: "Archive, delete or keep (dismiss) addresses that never received mail",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ action: z.enum(["archive", "delete", "keep"]), ids: z.array(z.string()).min(1).max(1000), days: z.number().int().min(1).max(3650).default(30) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      // Only act on addresses that are still stale: a mail may have arrived since the list was shown.
      const allowed = new Set(staleRows(d, user, body.days).map((x) => x.a.id));
      const ids = body.ids.filter((id) => allowed.has(id));
      if (ids.length) {
        const where = and(eq(addresses.userId, user.id), inArray(addresses.id, ids));
        if (body.action === "delete") d.db.delete(addresses).where(where).run();
        else if (body.action === "archive") d.db.update(addresses).set({ status: "archived", updatedAt: d.now() }).where(where).run();
        else d.db.update(addresses).set({ staleDismissedAt: d.now() }).where(where).run();
        for (const id of ids) d.bus.publish(user.id, { type: body.action === "delete" ? "address.deleted" : "address.updated", address_id: id });
      }
      return c.json({ affected: ids.length, skipped: body.ids.length - ids.length });
    },
  );
}
