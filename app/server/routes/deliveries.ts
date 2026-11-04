import { and, desc, eq, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter, Ctx } from "../lib/http.js";
import type { Deps } from "../context.js";
import { addresses, deliveryFailures, domains, messages, type DeliveryFailure } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { canRetry, retryFailure } from "../services/deliveries.js";

function failureOut(deps: Deps, f: DeliveryFailure, extra: { address: string | null; subject: string | null; from: string | null }) {
  return {
    id: f.id,
    message_id: f.messageId,
    address_id: f.addressId,
    address: extra.address,
    subject: extra.subject,
    from: extra.from,
    destination: f.destination,
    transport: f.transport,
    kind: f.kind,
    reason: f.reason,
    detail: f.detail,
    delivered_to: f.deliveredTo,
    retry_count: f.retryCount,
    last_retry_at: f.lastRetryAt,
    resolved_at: f.resolvedAt,
    created_at: f.createdAt,
    can_retry: canRetry(deps, f),
  };
}

export function registerDeliveries(r: ApiRouter) {
  const owned = (c: Ctx) => {
    const row = c
      .get("deps")
      .db.select()
      .from(deliveryFailures)
      .where(and(eq(deliveryFailures.id, c.req.param("id")!), eq(deliveryFailures.userId, c.get("user")!.id)))
      .get();
    if (!row) throw notFound("Failed delivery");
    return row;
  };
  const withContext = (deps: Deps, f: DeliveryFailure) => {
    const m = f.messageId
      ? deps.db.select({ subject: messages.subject, from: messages.fromAddr }).from(messages).where(eq(messages.id, f.messageId)).get()
      : undefined;
    const a = f.addressId
      ? deps.db
          .select({ local: addresses.localPart, domain: domains.name })
          .from(addresses)
          .innerJoin(domains, eq(domains.id, addresses.domainId))
          .where(eq(addresses.id, f.addressId))
          .get()
      : undefined;
    return failureOut(deps, f, { address: a ? `${a.local}@${a.domain}` : null, subject: m?.subject ?? null, from: m?.from ?? null });
  };

  r.add(
    {
      method: "get",
      path: "/v1/delivery-failures",
      summary: "Forwards that failed, bounced or were refused, newest first",
      tags: ["deliveries"],
      auth: "user",
      query: z.object({
        status: z.enum(["open", "resolved", "all"]).default("open"),
        kind: z.enum(["failed", "rejected", "bounced"]).optional(),
        address_id: z.string().max(64).optional(),
        destination: z.string().max(254).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    },
    (c, { query }) => {
      const d = c.get("deps");
      const where: SQL[] = [eq(deliveryFailures.userId, c.get("user")!.id)];
      if (query.status === "open") where.push(isNull(deliveryFailures.resolvedAt));
      if (query.status === "resolved") where.push(isNotNull(deliveryFailures.resolvedAt));
      if (query.kind) where.push(eq(deliveryFailures.kind, query.kind));
      if (query.address_id) where.push(eq(deliveryFailures.addressId, query.address_id));
      if (query.destination) where.push(eq(deliveryFailures.destination, query.destination.toLowerCase()));
      if (query.before) where.push(lt(deliveryFailures.createdAt, query.before));
      const rows = d.db
        .select()
        .from(deliveryFailures)
        .where(and(...where))
        .orderBy(desc(deliveryFailures.createdAt))
        .limit(query.limit)
        .all();
      return c.json({ failures: rows.map((f) => withContext(d, f)) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/delivery-failures/:id/retry",
      summary: "Send the mail again to the same destination (over the app's SMTP server)",
      description: "Possible while the original is kept (3 days) and the app has an outgoing SMTP server for the domain; 409 otherwise.",
      tags: ["deliveries"],
      auth: "user",
    },
    async (c) => {
      const d = c.get("deps");
      const f = await retryFailure(d, owned(c));
      return c.json({ failure: withContext(d, f), delivered: !!f.resolvedAt });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/delivery-failures/:id/dismiss",
      summary: "Mark a failed delivery as handled",
      tags: ["deliveries"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const f = owned(c);
      d.db.update(deliveryFailures).set({ resolvedAt: d.now() }).where(eq(deliveryFailures.id, f.id)).run();
      return c.json({ failure: withContext(d, d.db.select().from(deliveryFailures).where(eq(deliveryFailures.id, f.id)).get()!) });
    },
  );
}
