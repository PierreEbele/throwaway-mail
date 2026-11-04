import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { DAY } from "../lib/time.js";
import { addresses } from "../db/schema.js";
import { addressOut } from "../services/serialize.js";
import { checkCategory } from "../services/categories.js";
import { createAddress, ownedAddress } from "../services/addresses.js";

/** Replacing, extending and mass-pausing addresses. */
export function registerLifecycle(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/replace",
      summary: "Create a fresh address for the same site and pause the old one",
      description:
        "Copies site, category, forwarding, pin and protections. The old address is paused (mail rejected) and its leak warning cleared.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ archive_old: z.boolean().default(false) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a: old } = ownedAddress(d, user, c.req.param("id")!);
      const { a, domain } = createAddress(d, user, {
        domain: old.domainId,
        site_name: old.siteName,
        site_url: old.siteUrl,
        label: old.label ?? undefined,
        forward: old.forwardEnabled,
        destination_id: old.destinationId ?? undefined,
        category_id: old.categoryId,
      });
      d.db
        .update(addresses)
        .set({
          pinned: old.pinned,
          blockPromos: old.blockPromos,
          siteLock: old.siteLock,
          blockedSendersJson: old.blockedSendersJson,
          trustedSendersJson: old.trustedSendersJson,
        })
        .where(eq(addresses.id, a.id))
        .run();
      d.db
        .update(addresses)
        .set({
          status: body.archive_old ? "archived" : "paused",
          pinned: false,
          leakSender: null,
          leakAt: null,
          label: `replaced by ${a.localPart}@${domain}`,
          updatedAt: d.now(),
        })
        .where(eq(addresses.id, old.id))
        .run();
      d.bus.publish(user.id, { type: "address.updated", address_id: old.id });
      return c.json(
        { address: addressOut(d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain), replaced_id: old.id },
        201,
      );
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/extend",
      summary: "Push an address's expiry back (or remove it)",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ days: z.number().int().min(1).max(3650).nullable().describe("null removes the expiry") }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a, domain } = ownedAddress(d, user, c.req.param("id")!);
      const now = d.now();
      const expiresAt = body.days === null ? null : Math.max(a.expiresAt ?? now, now) + body.days * DAY;
      // Extending an address that was paused because it expired brings it back.
      const revive =
        a.status === "paused" && a.burnReason === "expired" ? { status: "active" as const, burnReason: null, burnedAt: null } : {};
      d.db
        .update(addresses)
        .set({ expiresAt, expiryRemindedAt: null, updatedAt: now, ...revive })
        .where(eq(addresses.id, a.id))
        .run();
      d.bus.publish(user.id, { type: "address.updated", address_id: a.id });
      return c.json({ address: addressOut(d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain) });
    },
  );

  // --- Panic button ------------------------------------------------------------------------------
  r.add(
    {
      method: "post",
      path: "/v1/panic",
      summary: "Pause every active address (or one category's) at once; undo resumes exactly those",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ action: z.enum(["pause", "undo"]).default("pause"), category_id: z.string().nullable().optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const now = d.now();
      let affected: number;
      if (body.action === "pause") {
        checkCategory(d, user, body.category_id);
        const conds = [eq(addresses.userId, user.id), eq(addresses.status, "active"), eq(addresses.isUnassigned, false)];
        if (body.category_id) conds.push(eq(addresses.categoryId, body.category_id));
        affected = d.db
          .update(addresses)
          .set({ status: "paused", burnReason: "panic", burnedAt: now, updatedAt: now })
          .where(and(...conds))
          .run().changes;
      } else {
        affected = d.db
          .update(addresses)
          .set({ status: "active", burnReason: null, burnedAt: null, updatedAt: now })
          .where(and(eq(addresses.userId, user.id), eq(addresses.status, "paused"), eq(addresses.burnReason, "panic")))
          .run().changes;
      }
      d.bus.publish(user.id, { type: "address.updated", address_id: "" });
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ affected });
    },
  );
}
