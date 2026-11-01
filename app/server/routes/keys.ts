import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { apiKeys } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { createApiKey } from "../auth/tokens.js";

const keyOut = (k: typeof apiKeys.$inferSelect) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  created_at: k.createdAt,
  last_used_at: k.lastUsedAt,
  revoked_at: k.revokedAt,
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
      tags: ["keys"],
      auth: "user",
      body: z.object({ name: z.string().trim().min(1).max(80) }),
      responses: { 201: "{ key, api_key }" },
    },
    (c, { body }) => {
      const { key, row } = createApiKey(c.get("deps"), c.get("user")!.id, body.name);
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
