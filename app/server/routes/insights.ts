import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { DAY } from "../lib/time.js";
import { addresses, domains, extractedItems, messages } from "../db/schema.js";
import { senderDomain } from "../lib/senders.js";
import { addressOut } from "../services/serialize.js";
import { ownedAddress } from "../services/addresses.js";

/** Per-address statistics and the periodic digest. */
export function registerInsights(r: ApiRouter) {
  r.add(
    { method: "get", path: "/v1/addresses/:id/stats", summary: "Mail statistics for one address", tags: ["addresses"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a } = ownedAddress(d, user, c.req.param("id")!);
      const now = d.now();
      const rows = d.db
        .select({ id: messages.id, at: messages.receivedAt, from: messages.fromAddr, read: messages.readAt })
        .from(messages)
        .where(eq(messages.addressId, a.id))
        .all();
      const weeks = Array.from({ length: 12 }, () => 0);
      const senders = new Map<string, number>();
      for (const m of rows) {
        const w = Math.floor((now - m.at) / (7 * DAY));
        if (w >= 0 && w < 12) weeks[11 - w]!++;
        const s = senderDomain(m.from) ?? "unknown";
        senders.set(s, (senders.get(s) ?? 0) + 1);
      }
      const withCode = rows.length
        ? d.db
            .select({ n: sql<number>`count(distinct ${extractedItems.messageId})` })
            .from(extractedItems)
            .where(
              and(
                inArray(
                  extractedItems.messageId,
                  rows.map((m) => m.id),
                ),
                eq(extractedItems.kind, "code"),
                eq(extractedItems.rank, 0),
              ),
            )
            .get()!.n
        : 0;
      return c.json({
        total: rows.length,
        unread: rows.filter((m) => !m.read).length,
        with_code: withCode,
        first_at: rows.length ? Math.min(...rows.map((m) => m.at)) : null,
        last_at: rows.length ? Math.max(...rows.map((m) => m.at)) : null,
        per_week: weeks,
        top_senders: [...senders]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 5)
          .map(([domain, count]) => ({ domain, count })),
      });
    },
  );

  // --- Weekly summary --------------------------------------------------------------------------
  r.add(
    {
      method: "get",
      path: "/v1/digest",
      summary: "Summary of the last `days` days: new addresses, busiest addresses, leaks, silent addresses",
      tags: ["addresses"],
      auth: "user",
      query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const since = d.now() - query.days * DAY;
      const base = and(eq(addresses.userId, user.id), eq(addresses.isUnassigned, false), ne(addresses.status, "archived"));
      const list = (where: ReturnType<typeof and>, order = desc(addresses.createdAt)) =>
        d.db
          .select({ a: addresses, domain: domains.name })
          .from(addresses)
          .innerJoin(domains, eq(domains.id, addresses.domainId))
          .where(where)
          .orderBy(order)
          .limit(20)
          .all()
          .map((x) => addressOut(x.a, x.domain));
      const busiest = d.db
        .select({ id: messages.addressId, n: sql<number>`count(*)` })
        .from(messages)
        .where(and(eq(messages.userId, user.id), gte(messages.receivedAt, since)))
        .groupBy(messages.addressId)
        .orderBy(desc(sql`count(*)`))
        .limit(5)
        .all();
      const busyRows = busiest.length
        ? new Map(
            d.db
              .select({ a: addresses, domain: domains.name })
              .from(addresses)
              .innerJoin(domains, eq(domains.id, addresses.domainId))
              .where(
                inArray(
                  addresses.id,
                  busiest.map((b) => b.id),
                ),
              )
              .all()
              .map((x) => [x.a.id, x]),
          )
        : new Map();
      const received = d.db
        .select({ n: sql<number>`count(*)` })
        .from(messages)
        .where(and(eq(messages.userId, user.id), gte(messages.receivedAt, since)))
        .get()!.n;
      return c.json({
        days: query.days,
        since,
        received,
        created: list(and(base, gte(addresses.createdAt, since))),
        busiest: busiest
          .filter((b) => busyRows.has(b.id))
          .map((b) => ({ address: addressOut(busyRows.get(b.id)!.a, busyRows.get(b.id)!.domain), count: b.n })),
        leaks: list(and(base, isNotNull(addresses.leakAt)), desc(addresses.leakAt)),
        expiring: list(
          and(base, isNotNull(addresses.expiresAt), gte(addresses.expiresAt, d.now()), sql`${addresses.expiresAt} < ${d.now() + 3 * DAY}`),
          asc(addresses.expiresAt),
        ),
        silent: list(
          and(base, isNull(addresses.lastMessageAt), sql`${addresses.createdAt} < ${d.now() - 30 * DAY}`, eq(addresses.pinned, false)),
          asc(addresses.createdAt),
        ),
      });
    },
  );
}
