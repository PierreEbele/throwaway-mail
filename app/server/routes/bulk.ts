import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, messages, type Address } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { checkCategory } from "../services/categories.js";

/** Actions on several addresses at once. */
export function registerBulk(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/addresses/bulk",
      summary: "Apply one action to several addresses",
      tags: ["addresses"],
      auth: "user",
      body: z.object({
        ids: z.array(z.string()).min(1).max(1000),
        action: z.enum(["move", "pin", "unpin", "archive", "unarchive", "pause", "resume", "delete", "read"]),
        category_id: z.string().nullable().optional(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const where = and(eq(addresses.userId, user.id), inArray(addresses.id, body.ids));
      const now = d.now();
      let affected = 0;
      if (body.action === "move") {
        if (body.category_id === undefined) throw badRequest("category_id is required for move");
        checkCategory(d, user, body.category_id);
        affected = d.db.update(addresses).set({ categoryId: body.category_id, updatedAt: now }).where(where).run().changes;
      } else if (body.action === "delete") {
        affected = d.db.delete(addresses).where(where).run().changes;
      } else if (body.action === "read") {
        const ids = d.db.select({ id: addresses.id }).from(addresses).where(where).all().map((x) => x.id);
        if (ids.length) affected = d.db.update(messages).set({ readAt: now }).where(and(inArray(messages.addressId, ids), isNull(messages.readAt))).run().changes;
      } else {
        const set: Partial<Address> =
          body.action === "pin" ? { pinned: true }
          : body.action === "unpin" ? { pinned: false }
          : body.action === "archive" ? { status: "archived" }
          : body.action === "pause" ? { status: "paused" }
          : { status: "active" };
        affected = d.db.update(addresses).set({ ...set, updatedAt: now }).where(where).run().changes;
      }
      for (const id of body.ids) d.bus.publish(user.id, { type: body.action === "delete" ? "address.deleted" : "address.updated", address_id: id });
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ affected });
    },
  );
}
