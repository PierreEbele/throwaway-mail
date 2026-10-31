import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, messages } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { isPrivateHost } from "../services/notify.js";

/** Newsletter handling (List-Unsubscribe). */
export function registerNewsletters(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/messages/:id/unsubscribe",
      summary: "Unsubscribe from the newsletter a message came from",
      description:
        "With RFC 8058 one-click support the server POSTs the unsubscribe request itself (done: true). Otherwise the unsubscribe URL (or mailto) is returned for the user to open.",
      tags: ["messages"],
      auth: "user",
      body: z.object({ block: z.boolean().default(false).describe("Also reject future newsletters on this address") }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const m = d.db.select().from(messages).where(and(eq(messages.id, c.req.param("id")!), eq(messages.userId, user.id))).get();
      if (!m) throw notFound("Message");
      if (body.block) d.db.update(addresses).set({ blockPromos: true, updatedAt: d.now() }).where(and(eq(addresses.id, m.addressId), eq(addresses.userId, user.id))).run();
      if (!m.unsubscribeUrl && !m.unsubscribeMailto) throw badRequest("This message has no List-Unsubscribe header");
      let done = false;
      let error: string | null = null;
      // The URL comes from the sender: https only, never towards the server's own network.
      if (m.unsubscribeOneClick && m.unsubscribeUrl && !isPrivateHost(new URL(m.unsubscribeUrl).hostname)) {
        try {
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
      }
      if (done) d.db.update(messages).set({ unsubscribedAt: d.now() }).where(eq(messages.id, m.id)).run();
      d.bus.publish(user.id, { type: "address.updated", address_id: m.addressId });
      return c.json({ done, error, url: done ? null : m.unsubscribeUrl, mailto: done ? null : m.unsubscribeMailto, blocked: body.block });
    },
  );
}
