import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, apiKeys, domains } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { createApiKey } from "../auth/tokens.js";

const keyOut = (k: typeof apiKeys.$inferSelect) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  created_at: k.createdAt,
  last_used_at: k.lastUsedAt,
  revoked_at: k.revokedAt,
  scope: k.scope,
  address_ids: k.addressIds ?? null,
  domain_ids: k.domainIds ?? null,
  expires_at: k.expiresAt,
});

export function registerKeys(r: ApiRouter) {
  r.add(
    { method: "get", path: "/v1/keys", summary: "List own API keys (secrets are never returned)", tags: ["keys"], auth: "user" },
    (c) => {
      const rows = c
        .get("deps")
        .db.select()
        .from(apiKeys)
        .where(eq(apiKeys.userId, c.get("user")!.id))
        .orderBy(desc(apiKeys.createdAt))
        .all();
      return c.json({ keys: rows.map(keyOut) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/keys",
      summary: "Create an API key (the secret is shown once)",
      description:
        "`scope`: `full` (default) or `read` (GET only, every write returns 403 insufficient_scope). `address_ids` restricts the key to those addresses: it only lists them, only gets their SSE events, can only reach `/v1/addresses/:id/…` and `/v1/messages/:id/…` routes for them (other ids answer 404), and every other route, address creation and the compatibility API answer 403. `domain_ids` (ids or names) restricts the key to those domains: it only creates addresses on them (random and rotating domains stay within them; any other domain answers 403 domain_not_allowed), only lists and reaches addresses on them, only sees them in `GET /v1/domains`, and may use the compatibility API; account-wide routes answer 403. `expires_at` (epoch ms) or `expires_in_days` make the key stop working afterwards. Read-only and restricted keys cannot create or revoke keys.",
      tags: ["keys"],
      auth: "user",
      body: z.object({
        name: z.string().trim().min(1).max(80),
        scope: z.enum(["full", "read"]).default("full"),
        address_ids: z.array(z.string()).min(1).max(1000).nullable().optional().describe("Restrict the key to these address ids"),
        domain_ids: z
          .array(z.string().trim().min(1))
          .min(1)
          .max(100)
          .nullable()
          .optional()
          .describe("Restrict the key to these domains (ids or names)"),
        expires_at: z.number().int().positive().nullable().optional().describe("Epoch ms after which the key stops working"),
        expires_in_days: z.number().int().min(1).max(3650).optional(),
      }),
      responses: { 201: "{ key, api_key }" },
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      if (body.expires_at != null && body.expires_in_days) throw badRequest("Pass expires_at or expires_in_days, not both");
      const expiresAt = body.expires_in_days ? d.now() + body.expires_in_days * 86400_000 : (body.expires_at ?? null);
      if (expiresAt != null && expiresAt <= d.now()) throw badRequest("expires_at must be in the future");
      const ids = body.address_ids ? [...new Set(body.address_ids)] : null;
      if (ids) {
        const owned = d.db
          .select({ id: addresses.id })
          .from(addresses)
          .where(and(eq(addresses.userId, user.id), inArray(addresses.id, ids)))
          .all();
        if (owned.length !== ids.length) throw badRequest("Unknown address in address_ids");
      }
      if (ids && body.domain_ids) throw badRequest("Pass address_ids or domain_ids, not both");
      let domainIds: string[] | null = null;
      if (body.domain_ids) {
        const wanted = [...new Set(body.domain_ids)];
        const rows = d.db
          .select({ id: domains.id, name: domains.name })
          .from(domains)
          .where(
            or(
              inArray(domains.id, wanted),
              inArray(
                domains.name,
                wanted.map((x) => x.toLowerCase()),
              ),
            ),
          )
          .all();
        const known = new Set(rows.flatMap((x) => [x.id, x.name]));
        const unknown = wanted.find((x) => !known.has(x) && !known.has(x.toLowerCase()));
        if (unknown) throw badRequest(`Unknown domain ${unknown} in domain_ids`);
        domainIds = [...new Set(rows.map((x) => x.id))];
      }
      const { key, row } = createApiKey(d, user.id, body.name, { scope: body.scope, addressIds: ids, domainIds, expiresAt });
      return c.json({ key, api_key: keyOut({ ...row, lastUsedAt: null, revokedAt: null }) }, 201);
    },
  );

  r.add({ method: "delete", path: "/v1/keys/:id", summary: "Revoke an API key", tags: ["keys"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const res = d.db
      .update(apiKeys)
      .set({ revokedAt: d.now() })
      .where(and(eq(apiKeys.id, c.req.param("id")!), eq(apiKeys.userId, c.get("user")!.id), isNull(apiKeys.revokedAt)))
      .run();
    if (!res.changes) throw notFound("API key");
    return c.json({ ok: true });
  });
}
