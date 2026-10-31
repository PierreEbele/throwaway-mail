import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { savedSearches } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";
const Name = z.string().trim().min(1).max(40);

/** Smart folders: saved /v1/addresses filters. */
export function registerSmartFolders(r: ApiRouter) {
  const Params = z.record(z.string(), z.string().max(200)).refine((o) => Object.keys(o).length <= 12, "too many parameters");
  const searchOut = (s: typeof savedSearches.$inferSelect) => ({ id: s.id, name: s.name, params: JSON.parse(s.paramsJson) as Record<string, string>, position: s.position, created_at: s.createdAt });

  r.add({ method: "get", path: "/v1/saved-searches", summary: "List smart folders", tags: ["categories"], auth: "user" }, (c) => {
    const d = c.get("deps");
    return c.json({ searches: d.db.select().from(savedSearches).where(eq(savedSearches.userId, c.get("user")!.id)).orderBy(asc(savedSearches.position), asc(savedSearches.createdAt)).all().map(searchOut) });
  });

  r.add(
    {
      method: "post",
      path: "/v1/saved-searches",
      summary: "Save a smart folder (a set of /v1/addresses query parameters)",
      tags: ["categories"],
      auth: "user",
      body: z.object({ name: Name, params: Params }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const max = d.db.select({ p: sql<number>`coalesce(max(${savedSearches.position}), -1)` }).from(savedSearches).where(eq(savedSearches.userId, user.id)).get()!.p;
      const row = { id: newId("srch"), userId: user.id, name: body.name, paramsJson: JSON.stringify(body.params), position: max + 1, createdAt: d.now() };
      d.db.insert(savedSearches).values(row).run();
      d.bus.publish(user.id, { type: "category.changed" });
      return c.json({ search: searchOut(row) }, 201);
    },
  );

  r.add({ method: "delete", path: "/v1/saved-searches/:id", summary: "Delete a smart folder", tags: ["categories"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const user = c.get("user")!;
    const res = d.db.delete(savedSearches).where(and(eq(savedSearches.id, c.req.param("id")!), eq(savedSearches.userId, user.id))).run();
    if (!res.changes) throw notFound("Smart folder");
    d.bus.publish(user.id, { type: "category.changed" });
    return c.json({ ok: true });
  });
}
