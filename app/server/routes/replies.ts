import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { reverseContacts, type ReverseContact } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { ownedAddress } from "../services/addresses.js";

function contactOut(c: ReverseContact, domain: string) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    reverse_address: `r+${c.token}@${domain}`,
    blocked: c.blocked,
    created_at: c.createdAt,
    last_reply_at: c.lastReplyAt,
    reply_count: c.replyCount,
  };
}

/** Reverse-alias contacts of an address (senders whose forwarded mail carried a reply address). */
export function registerReplies(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/addresses/:id/contacts",
      summary: "List the reverse-alias contacts of an address",
      tags: ["addresses"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const { a, domain } = ownedAddress(d, c.get("user")!, c.req.param("id")!);
      const rows = d.db
        .select()
        .from(reverseContacts)
        .where(eq(reverseContacts.addressId, a.id))
        .orderBy(desc(reverseContacts.createdAt))
        .all();
      return c.json({ contacts: rows.map((x) => contactOut(x, domain)) });
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/addresses/:id/contacts/:cid",
      summary: "Block or unblock replies to one contact",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ blocked: z.boolean() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const { a, domain } = ownedAddress(d, c.get("user")!, c.req.param("id")!);
      const where = and(eq(reverseContacts.id, c.req.param("cid")!), eq(reverseContacts.addressId, a.id));
      if (!d.db.select().from(reverseContacts).where(where).get()) throw notFound("Contact");
      d.db.update(reverseContacts).set({ blocked: body.blocked }).where(where).run();
      return c.json({ contact: contactOut(d.db.select().from(reverseContacts).where(where).get()!, domain) });
    },
  );

  r.add(
    {
      method: "delete",
      path: "/v1/addresses/:id/contacts/:cid",
      summary: "Forget a contact: its reverse address stops working (a new one is made at the next mail)",
      tags: ["addresses"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const { a } = ownedAddress(d, c.get("user")!, c.req.param("id")!);
      const res = d.db
        .delete(reverseContacts)
        .where(and(eq(reverseContacts.id, c.req.param("cid")!), eq(reverseContacts.addressId, a.id)))
        .run();
      if (!res.changes) throw notFound("Contact");
      return c.json({ ok: true });
    },
  );
}
