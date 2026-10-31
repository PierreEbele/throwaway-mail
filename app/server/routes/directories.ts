import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { directories } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";

/** Directories: reserved prefixes that create addresses on the fly. */
export function registerDirectories(r: ApiRouter) {
  r.add({ method: "get", path: "/v1/directories", summary: "List own directories (<name>.<site>@domain creates addresses on the fly)", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const rows = d.db.select().from(directories).where(eq(directories.userId, c.get("user")!.id)).orderBy(asc(directories.name)).all();
    return c.json({ directories: rows.map((x) => ({ id: x.id, name: x.name, created_at: x.createdAt })) });
  });

  r.add(
    {
      method: "post",
      path: "/v1/directories",
      summary: "Reserve a directory name",
      description: "Mail to <name>.<anything>@<any active domain> then creates an address for site <anything> owned by you. Names are global (first come, first served), 3–32 chars a-z0-9, max 5 per user.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ name: z.string().trim().toLowerCase().regex(/^[a-z0-9]{3,32}$/, "3–32 letters or digits") }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const mine = d.db.select({ n: sql<number>`count(*)` }).from(directories).where(eq(directories.userId, user.id)).get()!.n;
      if (mine >= 5) throw badRequest("At most 5 directories per user");
      if (d.db.select().from(directories).where(eq(directories.name, body.name)).get()) throw conflict(`Directory ${body.name} is taken`);
      const row = { id: newId("dir"), userId: user.id, name: body.name, createdAt: d.now() };
      d.db.insert(directories).values(row).run();
      return c.json({ directory: { id: row.id, name: row.name, created_at: row.createdAt } }, 201);
    },
  );

  r.add({ method: "delete", path: "/v1/directories/:id", summary: "Release a directory (addresses it created are kept)", tags: ["addresses"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const res = d.db.delete(directories).where(and(eq(directories.id, c.req.param("id")!), eq(directories.userId, c.get("user")!.id))).run();
    if (!res.changes) throw notFound("Directory");
    return c.json({ ok: true });
  });
}
