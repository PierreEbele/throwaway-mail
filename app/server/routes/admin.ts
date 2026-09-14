import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { auditLog, sessions, users } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { userOut } from "../services/serialize.js";

export function registerAdmin(r: ApiRouter) {
  r.add({ method: "get", path: "/v1/admin/users", summary: "List users", tags: ["admin"], auth: "admin" }, (c) => {
    const rows = c.get("deps").db.select().from(users).orderBy(users.createdAt).all();
    return c.json({ users: rows.map(userOut) });
  });

  r.add(
    {
      method: "patch",
      path: "/v1/admin/users/:id",
      summary: "Disable or re-enable a user (roles come from the identity provider's groups)",
      tags: ["admin"],
      auth: "admin",
      body: z.object({ disabled: z.boolean() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const me = c.get("user")!;
      const id = c.req.param("id")!;
      const target = d.db.select().from(users).where(eq(users.id, id)).get();
      if (!target) throw notFound("User");
      if (id === me.id && body.disabled) throw badRequest("You cannot disable yourself");
      d.db.update(users).set({ disabled: body.disabled }).where(eq(users.id, id)).run();
      if (body.disabled) d.db.delete(sessions).where(eq(sessions.userId, id)).run();
      audit(d, me.id, body.disabled ? "user.disabled" : "user.enabled", id, undefined, clientIp(c));
      return c.json({ user: userOut(d.db.select().from(users).where(eq(users.id, id)).get()!) });
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/admin/audit",
      summary: "Audit log",
      tags: ["admin"],
      auth: "admin",
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
    },
    (c, { query }) => {
      const rows = c.get("deps").db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(query.limit).all();
      return c.json({
        entries: rows.map((e) => ({ id: e.id, user_id: e.userId, action: e.action, target: e.target, meta: e.metaJson ? JSON.parse(e.metaJson) : null, ip: e.ip, created_at: e.createdAt })),
      });
    },
  );
}
