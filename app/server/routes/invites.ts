import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { invites } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { createInvite, findUserByEmail, inviteUrl, pendingInvites, type Invite } from "../auth/invites.js";
import type { Deps } from "../context.js";
import { audit } from "../services/audit.js";

const inviteOut = (d: Deps, i: Invite) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  reset: !!findUserByEmail(d, i.email),
  created_at: i.createdAt,
  expires_at: i.expiresAt,
});

/** Admin side of local accounts: invite links and password reset links (an invite for an existing local account). */
export function registerInvites(r: ApiRouter) {
  r.add({ method: "get", path: "/v1/admin/invites", summary: "Pending invites and reset links", tags: ["admin"], auth: "admin" }, (c) => {
    const d = c.get("deps");
    return c.json({ invites: pendingInvites(d).map((i) => inviteOut(d, i)) });
  });

  r.add(
    {
      method: "post",
      path: "/v1/admin/invites",
      summary: "Create a one-time invite link (7 days); for an existing local account it is a password reset link",
      tags: ["admin"],
      auth: "admin",
      body: z.object({ email: z.string().trim().email().max(254), role: z.enum(["admin", "user"]).default("user") }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const me = c.get("user")!;
      const { invite, token, reset } = createInvite(d, body.email, body.role, me.id);
      audit(d, me.id, reset ? "user.reset_link_created" : "invite.created", invite.email, { role: invite.role }, clientIp(c));
      return c.json({ invite: inviteOut(d, invite), url: inviteUrl(d, token) }, 201);
    },
  );

  r.add(
    { method: "delete", path: "/v1/admin/invites/:id", summary: "Revoke an invite or reset link", tags: ["admin"], auth: "admin" },
    (c) => {
      const d = c.get("deps");
      const id = c.req.param("id")!;
      const res = d.db
        .delete(invites)
        .where(and(eq(invites.id, id), isNull(invites.usedAt)))
        .run();
      if (!res.changes) throw notFound("Invite");
      audit(d, c.get("user")!.id, "invite.revoked", id, undefined, clientIp(c));
      return c.json({ ok: true });
    },
  );
}
