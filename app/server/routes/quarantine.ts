import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter, Ctx } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { addresses, domains, messageRaw, messages } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { forwardStored, recordAttempts } from "../services/deliveries.js";
import { forwardTargets } from "../services/ingest/forwarding.js";
import { RAW_KEEP_MS } from "../services/ingest/index.js";

export function registerQuarantine(r: ApiRouter) {
  const owned = (c: Ctx) => {
    const row = c
      .get("deps")
      .db.select()
      .from(messages)
      .where(and(eq(messages.id, c.req.param("id")!), eq(messages.userId, c.get("user")!.id), isNotNull(messages.quarantinedAt)))
      .get();
    if (!row) throw notFound("Quarantined message");
    return row;
  };

  r.add(
    { method: "get", path: "/v1/quarantine", summary: "List mail held in quarantine by a rule", tags: ["rules"], auth: "user" },
    (c) => {
      const d = c.get("deps");
      const rows = d.db
        .select({ m: messages, local: addresses.localPart, domain: domains.name, site: addresses.siteName })
        .from(messages)
        .innerJoin(addresses, eq(addresses.id, messages.addressId))
        .innerJoin(domains, eq(domains.id, addresses.domainId))
        .where(and(eq(messages.userId, c.get("user")!.id), isNotNull(messages.quarantinedAt)))
        .orderBy(desc(messages.quarantinedAt))
        .limit(500)
        .all();
      return c.json({
        messages: rows.map(({ m, local, domain, site }) => ({
          id: m.id,
          address_id: m.addressId,
          address: `${local}@${domain}`,
          site_name: site,
          from: m.fromAddr,
          from_name: m.fromName,
          subject: m.subject,
          received_at: m.receivedAt,
          quarantined_at: m.quarantinedAt,
          matched_rules: m.matchedRulesJson ? (JSON.parse(m.matchedRulesJson) as Array<{ id: string; name: string }>) : [],
          auth: { spf: m.spf, dkim: m.dkim, dmarc: m.dmarc },
          raw_size: m.rawSize,
        })),
      });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/quarantine/:id/release",
      summary: "Release a quarantined mail: forward it now (forward: true, the default) or just keep it in the inbox",
      description:
        "Forwarding is done by the app over SMTP (an IMAP domain's SMTP server or SMTP_RELAY_URL); without one, 409 is returned " +
        "and the mail can still be released with forward: false.",
      tags: ["rules"],
      auth: "user",
      body: z.object({ forward: z.boolean().default(true) }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const msg = owned(c);
      const address = d.db.select().from(addresses).where(eq(addresses.id, msg.addressId)).get()!;
      const targets = body.forward ? forwardTargets(d, address) : [];
      let failed = 0;
      let delivered: string[] = [];
      if (targets.length) {
        const attempts = await forwardStored(d, msg, address, targets);
        d.db
          .update(messages)
          .set({ forwardTo: targets.join(", ") })
          .where(eq(messages.id, msg.id))
          .run();
        failed = recordAttempts(d, msg.id, attempts, "smtp");
        delivered = attempts.filter((a) => a.ok).map((a) => a.to);
      }
      const now = d.now();
      d.db.update(messages).set({ quarantinedAt: null }).where(eq(messages.id, msg.id)).run();
      // Kept a little longer, like any forwarded mail, so a failed delivery can be retried.
      d.db
        .update(messageRaw)
        .set({ keepUntil: now + RAW_KEEP_MS })
        .where(eq(messageRaw.messageId, msg.id))
        .run();
      audit(d, msg.userId, "quarantine.released", msg.id, { forwarded_to: delivered, failed }, clientIp(c));
      d.bus.publish(msg.userId, { type: "address.updated", address_id: msg.addressId });
      return c.json({ ok: true, forwarded_to: delivered, failed });
    },
  );

  r.add({ method: "delete", path: "/v1/quarantine/:id", summary: "Delete a quarantined mail", tags: ["rules"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const msg = owned(c);
    d.db.delete(messages).where(eq(messages.id, msg.id)).run();
    d.bus.publish(msg.userId, { type: "address.updated", address_id: msg.addressId });
    return c.json({ ok: true });
  });
}
