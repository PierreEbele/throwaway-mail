import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, destinations, users } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { addressFallbackIds, userHeaderAllowlist } from "../services/ingest/forwarding.js";
import { ESSENTIAL_HEADERS } from "../services/ingest/transform.js";

const ids = z.array(z.string().max(64)).max(20);

/** Forwarding settings: fallback destinations (per user and per address) and the original-header allowlist. */
export function registerForwarding(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/forwarding/headers",
      summary: "Original headers kept when forwarding (null: all of them)",
      tags: ["destinations"],
      auth: "user",
    },
    (c) => c.json({ allowlist: userHeaderAllowlist(c.get("deps"), c.get("user")!.id), always_kept: [...ESSENTIAL_HEADERS] }),
  );

  r.add(
    {
      method: "put",
      path: "/v1/forwarding/headers",
      summary: "Set the original headers kept when forwarding (null: keep all)",
      description:
        "With a list, forwarded copies keep only the headers needed to read the mail (always_kept) plus these. Such copies are sent " +
        "as new messages from the alias (the Worker's SEND_EMAIL binding, or SMTP for IMAP domains), with the sender in Reply-To.",
      tags: ["destinations"],
      auth: "user",
      body: z.object({
        allowlist: z
          .array(
            z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^[a-z0-9-]{1,76}$/, "Header names only contain letters, digits and dashes"),
          )
          .max(50)
          .nullable(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const list = body.allowlist ? [...new Set(body.allowlist)] : null;
      d.db
        .update(users)
        .set({ forwardHeaderAllowlistJson: list ? JSON.stringify(list) : null })
        .where(eq(users.id, user.id))
        .run();
      return c.json({ allowlist: list, always_kept: [...ESSENTIAL_HEADERS] });
    },
  );

  r.add(
    {
      method: "put",
      path: "/v1/forwarding/fallbacks",
      summary: "Set the user's fallback chain: destinations tried in order when forwarding fails",
      tags: ["destinations"],
      auth: "user",
      body: z.object({ destination_ids: ids }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const mine = body.destination_ids.length
        ? d.db
            .select({ id: destinations.id })
            .from(destinations)
            .where(and(eq(destinations.userId, user.id), inArray(destinations.id, body.destination_ids)))
            .all()
        : [];
      if (mine.length !== new Set(body.destination_ids).size) throw badRequest("Unknown destination");
      d.db.transaction((tx) => {
        tx.update(destinations).set({ fallbackPosition: null }).where(eq(destinations.userId, user.id)).run();
        body.destination_ids.forEach((id, i) => tx.update(destinations).set({ fallbackPosition: i }).where(eq(destinations.id, id)).run());
      });
      return c.json({ destination_ids: body.destination_ids });
    },
  );

  r.add(
    {
      method: "put",
      path: "/v1/addresses/:id/fallbacks",
      summary: "Set this address's own fallback destinations (empty: use the user's chain)",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ destination_ids: ids }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const address = d.db
        .select()
        .from(addresses)
        .where(and(eq(addresses.id, c.req.param("id")!), eq(addresses.userId, user.id)))
        .get();
      if (!address) throw notFound("Address");
      const mine = body.destination_ids.length
        ? d.db
            .select({ id: destinations.id })
            .from(destinations)
            .where(and(eq(destinations.userId, user.id), inArray(destinations.id, body.destination_ids)))
            .all()
        : [];
      if (mine.length !== new Set(body.destination_ids).size) throw badRequest("Unknown destination");
      d.db
        .update(addresses)
        .set({
          fallbackDestinationIdsJson: body.destination_ids.length ? JSON.stringify(body.destination_ids) : null,
          updatedAt: d.now(),
        })
        .where(eq(addresses.id, address.id))
        .run();
      d.bus.publish(user.id, { type: "address.updated", address_id: address.id });
      const updated = d.db.select().from(addresses).where(eq(addresses.id, address.id)).get()!;
      return c.json({ destination_ids: addressFallbackIds(updated) });
    },
  );
}
