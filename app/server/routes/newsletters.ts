import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, messages } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { checkOutboundUrl } from "../lib/outbound.js";
import { ownedAddress } from "../services/addresses.js";
import { pickUnsubscribe, type UnsubscribeCandidate } from "../parser/unsubscribe.js";
import { candidatesOf } from "../services/unsubscribe.js";
import { visitUnsubscribe } from "../services/unsubscribe-visit.js";

/** Newsletter handling (List-Unsubscribe). */
export function registerNewsletters(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/messages/:id/unsubscribe",
      summary: "Unsubscribe from the newsletter a message came from",
      description:
        "With RFC 8058 one-click support the server POSTs the unsubscribe request itself (done: true). Otherwise it opens the https unsubscribe page itself and submits its confirmation form, " +
        "and returns done: true only when the page confirms. When it cannot, the unsubscribe URL (or mailto) is returned for the user to open.",
      tags: ["messages"],
      auth: "user",
      body: z.object({ block: z.boolean().default(false).describe("Also reject future newsletters on this address") }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const m = d.db
        .select()
        .from(messages)
        .where(and(eq(messages.id, c.req.param("id")!), eq(messages.userId, user.id)))
        .get();
      if (!m) throw notFound("Message");
      const target = m.unsubscribeUrl || m.unsubscribeMailto ? null : (candidatesOf(m)[0] ?? null);
      const url = target ? target.url : m.unsubscribeUrl;
      const mailto = target ? target.mailto : m.unsubscribeMailto;
      if (!url && !mailto) throw badRequest("This message has no unsubscribe link");
      if (body.block)
        d.db
          .update(addresses)
          .set({ blockPromos: true, updatedAt: d.now() })
          .where(and(eq(addresses.id, m.addressId), eq(addresses.userId, user.id)))
          .run();
      let done = false;
      let error: string | null = null;
      if (m.unsubscribeOneClick && m.unsubscribeUrl) {
        try {
          // The URL comes from the sender: https only, never towards the server's own network.
          await checkOutboundUrl(m.unsubscribeUrl, { resolve: d.resolve, httpsOnly: true });
          const res = await d.fetch(m.unsubscribeUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
          done = res.ok;
          if (!res.ok) error = `HTTP ${res.status}`;
        } catch (e) {
          error = (e as Error).message;
        }
      } else if (url && /^https:/i.test(url)) {
        // No one-click: open the page server-side, and submit its confirmation form if it has one.
        ({ done, error } = await visitUnsubscribe(d, url));
      }
      if (done) d.db.update(messages).set({ unsubscribedAt: d.now() }).where(eq(messages.id, m.id)).run();
      d.bus.publish(user.id, { type: "address.updated", address_id: m.addressId });
      return c.json({ done, error, url: done ? null : url, mailto: done ? null : mailto, blocked: body.block });
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/addresses/:id/unsubscribe",
      summary: "Best unsubscribe offer for an address",
      description:
        "Scans the address's recent messages (List-Unsubscribe headers, then unsubscribe links and buttons in the body) and returns the best candidate: " +
        "one-click first, then https, then mailto, then a body link. Senders already unsubscribed from are skipped. `offer` is null when nothing was found.",
      tags: ["messages"],
      auth: "user",
      responses: { 200: "{ offer: { message_id, from, from_name, kind, url, mailto, label } | null, senders }" },
    },
    async (c) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a } = ownedAddress(d, user, c.req.param("id")!);
      const rows = d.db
        .select()
        .from(messages)
        .where(and(eq(messages.addressId, a.id), eq(messages.userId, user.id)))
        .orderBy(desc(messages.receivedAt))
        .limit(200)
        .all();
      const done = new Set(rows.filter((m) => m.unsubscribedAt).map((m) => (m.fromAddr ?? "").toLowerCase()));
      const offers: Array<UnsubscribeCandidate & { message_id: string; from: string | null; from_name: string | null }> = [];
      for (const m of rows) {
        if (done.has((m.fromAddr ?? "").toLowerCase())) continue;
        const best = candidatesOf(m)[0];
        if (best) offers.push({ ...best, message_id: m.id, from: m.fromAddr, from_name: m.fromName });
      }
      const ranked = pickUnsubscribe(offers);
      const senders = new Set(ranked.map((o) => (o.from ?? "").toLowerCase())).size;
      const o = ranked[0];
      return c.json({
        offer: o
          ? {
              message_id: o.message_id,
              from: o.from,
              from_name: o.from_name,
              kind: o.kind,
              url: o.url,
              mailto: o.mailto,
              label: o.label ?? null,
            }
          : null,
        senders,
      });
    },
  );
}
