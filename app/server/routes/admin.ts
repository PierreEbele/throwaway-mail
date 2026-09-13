import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { auditLog, invites, sessions, users } from "../db/schema.js";
import { newId, randomToken, sha256 } from "../lib/crypto.js";
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
      summary: "Change a user's role or disable/enable them",
      tags: ["admin"],
      auth: "admin",
      body: z.object({ role: z.enum(["admin", "user"]).optional(), disabled: z.boolean().optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const me = c.get("user")!;
      const id = c.req.param("id")!;
      const target = d.db.select().from(users).where(eq(users.id, id)).get();
      if (!target) throw notFound("User");
      if (id === me.id && (body.disabled === true || body.role === "user")) throw badRequest("You cannot disable or demote yourself");
      if (target.role === "admin" && (body.role === "user" || body.disabled)) {
        const admins = d.db
          .select({ n: sql<number>`count(*)` })
          .from(users)
          .where(and(eq(users.role, "admin"), eq(users.disabled, false), ne(users.id, id)))
          .get()!.n;
        if (admins === 0) throw badRequest("At least one active admin must remain");
      }
      d.db.update(users).set(body).where(eq(users.id, id)).run();
      if (body.disabled) d.db.delete(sessions).where(eq(sessions.userId, id)).run();
      audit(d, me.id, "user.updated", id, body, clientIp(c));
      return c.json({ user: userOut(d.db.select().from(users).where(eq(users.id, id)).get()!) });
    },
  );

  r.add({ method: "get", path: "/v1/admin/invites", summary: "List invites", tags: ["admin"], auth: "admin" }, (c) => {
    const d = c.get("deps");
    const rows = d.db.select().from(invites).orderBy(desc(invites.createdAt)).limit(200).all();
    const now = d.now();
    return c.json({
      invites: rows.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        created_at: i.createdAt,
        expires_at: i.expiresAt,
        used_at: i.usedAt,
        state: i.usedAt ? "used" : i.expiresAt <= now ? "expired" : "pending",
      })),
    });
  });

  r.add(
    {
      method: "post",
      path: "/v1/admin/invites",
      summary: "Create an invite (the link is shown once)",
      tags: ["admin"],
      auth: "admin",
      body: z.object({
        email: z.string().trim().toLowerCase().email().optional(),
        role: z.enum(["admin", "user"]).default("user"),
        expires_in_days: z.number().int().min(1).max(30).default(7),
      }),
      responses: { 201: "Invite created; `url` contains the one-time token" },
    },
    (c, { body }) => {
      const d = c.get("deps");
      const token = randomToken(24);
      const row = {
        id: newId("inv"),
        tokenHash: sha256(token),
        email: body.email ?? null,
        role: body.role,
        createdBy: c.get("user")!.id,
        createdAt: d.now(),
        expiresAt: d.now() + body.expires_in_days * 86400_000,
      };
      d.db.insert(invites).values(row).run();
      audit(d, row.createdBy, "invite.created", row.id, { email: row.email, role: row.role }, clientIp(c));
      const url = `${d.config.APP_URL.replace(/\/$/, "")}/invite/${token}`;
      return c.json({ invite: { id: row.id, email: row.email, role: row.role, expires_at: row.expiresAt }, token, url }, 201);
    },
  );

  r.add({ method: "delete", path: "/v1/admin/invites/:id", summary: "Revoke an invite", tags: ["admin"], auth: "admin" }, (c) => {
    const d = c.get("deps");
    const res = d.db.delete(invites).where(eq(invites.id, c.req.param("id")!)).run();
    if (!res.changes) throw notFound("Invite");
    audit(d, c.get("user")!.id, "invite.revoked", c.req.param("id")!, undefined, clientIp(c));
    return c.json({ ok: true });
  });

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
