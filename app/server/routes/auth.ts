import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Ctx } from "../lib/http.js";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { invites, users } from "../db/schema.js";
import { newId, safeEqual, sha256 } from "../lib/crypto.js";
import { HttpError, badRequest, conflict, unauthorized } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE, createSession, deleteSession } from "../auth/tokens.js";
import { RateLimiter } from "../auth/ratelimit.js";
import { audit } from "../services/audit.js";
import { userOut } from "../services/serialize.js";

const Email = z.string().trim().toLowerCase().email().max(254);
const Password = z.string().min(10, "Password must be at least 10 characters").max(256);

function startSession(c: Ctx, userId: string) {
  const deps = c.get("deps");
  const s = createSession(deps, userId);
  setCookie(c, SESSION_COOKIE, s.token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "Lax",
    path: "/",
    expires: new Date(s.expiresAt),
  });
  return s.csrfToken;
}

export function registerAuth(r: ApiRouter) {
  let loginLimiter: RateLimiter | null = null;
  const limitLogin = (c: Ctx) => {
    loginLimiter ??= new RateLimiter(c.get("deps").config.LOGIN_RATE_LIMIT_PER_MINUTE);
    const res = loginLimiter.hit(`login:${clientIp(c)}`);
    if (!res.ok) {
      c.header("retry-after", String(res.retryAfter));
      throw new HttpError(429, "rate_limited", `Too many attempts, retry in ${res.retryAfter}s`);
    }
  };

  r.add({ method: "get", path: "/v1/auth/status", summary: "Whether first-run setup is needed", tags: ["auth"], auth: "none" }, (c) => {
    const d = c.get("deps");
    const count = d.db.select({ n: sql<number>`count(*)` }).from(users).get()!.n;
    return c.json({ needs_setup: count === 0, cloudflare_mode: d.cf.mode });
  });

  r.add(
    {
      method: "post",
      path: "/v1/auth/setup",
      summary: "Create the first admin with the one-time setup token printed in the logs",
      tags: ["auth"],
      auth: "none",
      body: z.object({ token: z.string().min(1), email: Email, password: Password }),
    },
    async (c, { body }) => {
      limitLogin(c);
      const d = c.get("deps");
      const count = d.db.select({ n: sql<number>`count(*)` }).from(users).get()!.n;
      if (count > 0 || !d.setup.token) throw conflict("Setup already completed");
      if (!safeEqual(body.token, d.setup.token)) throw unauthorized("Invalid setup token");
      const user = { id: newId("usr"), email: body.email, passwordHash: await hashPassword(body.password), role: "admin" as const, createdAt: d.now() };
      d.db.insert(users).values(user).run();
      d.setup.token = null;
      audit(d, user.id, "setup.admin_created", user.id, { email: user.email }, clientIp(c));
      const csrf = startSession(c, user.id);
      return c.json({ user: userOut({ ...user, disabled: false }), csrf_token: csrf }, 201);
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/login",
      summary: "Log in (sets the session cookie, returns the CSRF token)",
      tags: ["auth"],
      auth: "none",
      body: z.object({ email: Email, password: z.string().min(1).max(256) }),
    },
    async (c, { body }) => {
      limitLogin(c);
      const d = c.get("deps");
      const user = d.db.select().from(users).where(eq(users.email, body.email)).get();
      const ok = await verifyPassword(user?.passwordHash ?? null, body.password);
      if (!user || !ok || user.disabled) {
        d.logger.info("login failed", { ip: clientIp(c) });
        throw unauthorized("Invalid email or password");
      }
      const csrf = startSession(c, user.id);
      return c.json({ user: userOut(user), csrf_token: csrf });
    },
  );

  r.add({ method: "post", path: "/v1/auth/logout", summary: "Log out", tags: ["auth"], auth: "user" }, (c) => {
    const s = c.get("session");
    if (s) deleteSession(c.get("deps"), s.id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  r.add({ method: "get", path: "/v1/auth/me", summary: "Current user (and CSRF token for browser sessions)", tags: ["auth"], auth: "user" }, (c) => {
    return c.json({ user: userOut(c.get("user")!), csrf_token: c.get("session")?.csrfToken ?? null, auth: c.get("apiKeyId") ? "api_key" : "session" });
  });

  r.add(
    {
      method: "post",
      path: "/v1/auth/password",
      summary: "Change own password",
      tags: ["auth"],
      auth: "user",
      body: z.object({ current_password: z.string().min(1), new_password: Password }),
    },
    async (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      if (!(await verifyPassword(user.passwordHash, body.current_password))) throw badRequest("Current password is incorrect");
      d.db.update(users).set({ passwordHash: await hashPassword(body.new_password) }).where(eq(users.id, user.id)).run();
      audit(d, user.id, "user.password_changed", user.id, undefined, clientIp(c));
      return c.json({ ok: true });
    },
  );

  const findInvite = (c: Ctx, token: string) => {
    const d = c.get("deps");
    return d.db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.usedAt), gt(invites.expiresAt, d.now())))
      .get();
  };

  r.add(
    { method: "get", path: "/v1/auth/invite/:token", summary: "Inspect an invite before accepting it", tags: ["auth"], auth: "none" },
    (c) => {
      const inv = findInvite(c, c.req.param("token")!);
      if (!inv) throw new HttpError(404, "invalid_invite", "This invite is invalid, used or expired");
      return c.json({ email: inv.email, role: inv.role, expires_at: inv.expiresAt });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/accept-invite",
      summary: "Accept an invite and create the account",
      tags: ["auth"],
      auth: "none",
      body: z.object({ token: z.string().min(1), email: Email.optional(), password: Password }),
    },
    async (c, { body }) => {
      limitLogin(c);
      const d = c.get("deps");
      const inv = findInvite(c, body.token);
      if (!inv) throw new HttpError(404, "invalid_invite", "This invite is invalid, used or expired");
      const email = inv.email ?? body.email;
      if (!email) throw badRequest("Email is required for this invite");
      if (inv.email && body.email && body.email !== inv.email) throw badRequest("This invite is for a different email address");
      if (d.db.select().from(users).where(eq(users.email, email)).get()) throw conflict("An account with this email already exists");
      const user = { id: newId("usr"), email, passwordHash: await hashPassword(body.password), role: inv.role, createdAt: d.now() };
      d.db.transaction((tx) => {
        tx.insert(users).values(user).run();
        tx.update(invites).set({ usedAt: d.now(), usedBy: user.id }).where(eq(invites.id, inv.id)).run();
      });
      audit(d, user.id, "invite.accepted", inv.id, { email, role: inv.role }, clientIp(c));
      const csrf = startSession(c, user.id);
      return c.json({ user: userOut({ ...user, disabled: false }), csrf_token: csrf }, 201);
    },
  );
}
