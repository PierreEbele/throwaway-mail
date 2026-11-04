import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { invites, sessions, users, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { hashPassword, passwordSchema, verifyAgainstDummy, verifyPassword } from "../auth/passwords.js";
import { findUserByEmail, isLocalUser, normalizeEmail, validInvite } from "../auth/invites.js";
import type { Deps } from "../context.js";
import { audit } from "../services/audit.js";
import { userOut } from "../services/serialize.js";
import { signIn } from "./auth.js";
import { accountFailed, accountSucceeded, checkAccount, limitIp } from "../auth/limits.js";
import { CHALLENGE_TTL_MS, createChallenge, twoFactorEnabled } from "../auth/twofactor.js";
import { listPasskeys, secondFactorRequired } from "../auth/passkeys.js";
import { registerTwoFactor } from "./twofactor.js";
import { registerPasskeys } from "./passkeys.js";

const email = z.string().trim().email().max(254);
const name = z.string().trim().max(100).optional();

function createLocalUser(d: Deps, input: { email: string; name?: string; role: User["role"]; passwordHash: string }): User {
  const row = {
    id: newId("usr"),
    oidcSub: null,
    passwordHash: input.passwordHash,
    email: normalizeEmail(input.email),
    name: input.name || null,
    role: input.role,
    createdAt: d.now(),
  };
  d.db.insert(users).values(row).run();
  return d.db.select().from(users).where(eq(users.id, row.id)).get()!;
}

function signedIn(c: Parameters<typeof signIn>[0], user: User) {
  const s = signIn(c, user);
  return c.json({ user: userOut(user), csrf_token: s.csrfToken });
}

/** E-mail + password accounts: first-run setup, login, password change and invite acceptance. */
export function registerLocalAuth(r: ApiRouter) {
  registerTwoFactor(r);
  registerPasskeys(r);
  r.add(
    {
      method: "post",
      path: "/v1/auth/setup",
      summary: "Create the first admin account (only while the instance has no user at all)",
      tags: ["auth"],
      auth: "none",
      body: z.object({ email, name, password: passwordSchema }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const passwordHash = await hashPassword(body.password);
      // Checked after hashing (async) so two concurrent requests cannot both pass.
      const user = d.db.transaction(() => {
        if (d.db.select({ id: users.id }).from(users).limit(1).get()) return null;
        return createLocalUser(d, { ...body, role: "admin", passwordHash });
      });
      if (!user) throw forbidden("Setup is already done: sign in instead");
      audit(d, user.id, "user.created_via_setup", user.id, { email: user.email }, clientIp(c));
      return signedIn(c, user);
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/login",
      summary: "Sign in with e-mail and password (sets the session cookie)",
      tags: ["auth"],
      auth: "none",
      body: z.object({ email: z.string().max(254), password: z.string().max(1000) }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      // Unknown e-mails are counted too, so lockouts do not reveal which accounts exist.
      const accountKey = `login:${normalizeEmail(body.email)}`;
      checkAccount(c, accountKey);
      const user = findUserByEmail(d, body.email);
      const ok =
        user && isLocalUser(user) && user.passwordHash
          ? await verifyPassword(body.password, user.passwordHash)
          : await verifyAgainstDummy(body.password);
      if (!ok || !user) {
        accountFailed(c, accountKey);
        d.logger.info("password login refused", { ip: clientIp(c) });
        audit(
          d,
          user?.id ?? null,
          "auth.login_failed",
          normalizeEmail(body.email),
          { method: "password", reason: "wrong_credentials" },
          clientIp(c),
        );
        throw new HttpError(401, "invalid_credentials", "Wrong e-mail or password");
      }
      accountSucceeded(c, accountKey);
      if (user.disabled) {
        audit(d, user.id, "auth.login_failed", user.email, { method: "password", reason: "account_disabled" }, clientIp(c));
        throw new HttpError(403, "account_disabled", "Your account is disabled in this app");
      }
      if (secondFactorRequired(d, user)) {
        const methods: string[] = [];
        if (twoFactorEnabled(user)) methods.push("totp");
        if (listPasskeys(d, user.id).length) methods.push("passkey");
        methods.push("recovery");
        return c.json({
          two_factor_required: true,
          challenge: createChallenge(d, user.id),
          expires_in: CHALLENGE_TTL_MS / 1000,
          methods,
        });
      }
      d.logger.info("password login", { user_id: user.id, role: user.role });
      audit(d, user.id, "auth.login", user.id, { method: "password" }, clientIp(c));
      return signedIn(c, user);
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/password",
      summary: "Change the password of a local account (signs out its other sessions)",
      tags: ["auth"],
      auth: "user",
      body: z.object({ current_password: z.string().max(1000), new_password: passwordSchema }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = c.get("user")!;
      if (!isLocalUser(me) || !me.passwordHash) throw badRequest("Your password is managed by single sign-on");
      const accountKey = `password:${me.id}`;
      checkAccount(c, accountKey);
      if (!(await verifyPassword(body.current_password, me.passwordHash))) {
        accountFailed(c, accountKey);
        throw new HttpError(403, "invalid_credentials", "The current password is wrong");
      }
      accountSucceeded(c, accountKey);
      const passwordHash = await hashPassword(body.new_password);
      const current = c.get("session")?.id ?? "";
      d.db.transaction((tx) => {
        tx.update(users).set({ passwordHash }).where(eq(users.id, me.id)).run();
        tx.delete(sessions)
          .where(and(eq(sessions.userId, me.id), ne(sessions.id, current)))
          .run();
      });
      audit(d, me.id, "user.password_changed", me.id, undefined, clientIp(c));
      return c.json({ ok: true });
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/auth/invite/:token",
      summary: "Describe an invite or password reset link",
      tags: ["auth"],
      auth: "none",
    },
    (c) => {
      limitIp(c);
      const d = c.get("deps");
      const inv = validInvite(d, c.req.param("token")!);
      if (!inv) return c.json({ valid: false, email: null, role: null, reset: false });
      return c.json({ valid: true, email: inv.email, role: inv.role, reset: !!findUserByEmail(d, inv.email) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/invite/:token",
      summary: "Accept an invite (creates the local account) or a reset link (sets a new password); signs in",
      tags: ["auth"],
      auth: "none",
      body: z.object({ name, password: passwordSchema }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const token = c.req.param("token")!;
      // Guessing tokens: invalid links count as failures of the caller's IP.
      const accountKey = `invite:${clientIp(c)}`;
      checkAccount(c, accountKey);
      if (!validInvite(d, token)) {
        accountFailed(c, accountKey);
        throw notFound("Invite (it may have expired or already been used)");
      }
      const passwordHash = await hashPassword(body.password);
      // Re-validated synchronously after hashing so a link can only be used once.
      const result = d.db.transaction((tx) => {
        const inv = validInvite(d, token);
        if (!inv) throw notFound("Invite (it may have expired or already been used)");
        tx.update(invites).set({ usedAt: d.now() }).where(eq(invites.id, inv.id)).run();
        const existing = findUserByEmail(d, inv.email);
        if (!existing)
          return { user: createLocalUser(d, { email: inv.email, name: body.name, role: inv.role, passwordHash }), reset: false };
        if (!isLocalUser(existing)) throw conflict("This e-mail now belongs to a single sign-on account");
        if (existing.disabled) throw new HttpError(403, "account_disabled", "This account is disabled in this app");
        tx.update(users).set({ passwordHash }).where(eq(users.id, existing.id)).run();
        tx.delete(sessions).where(eq(sessions.userId, existing.id)).run();
        return { user: existing, reset: true };
      });
      const { user, reset } = result;
      audit(d, user.id, reset ? "user.password_reset" : "user.created_via_invite", user.id, { email: user.email }, clientIp(c));
      return signedIn(c, user);
    },
  );
}
