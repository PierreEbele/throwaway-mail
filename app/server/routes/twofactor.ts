import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter, Ctx } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { users, type User } from "../db/schema.js";
import { HttpError, badRequest, conflict, notFound } from "../lib/errors.js";
import { verifyPassword } from "../auth/passwords.js";
import { isLocalUser } from "../auth/invites.js";
import { accountFailed, accountSucceeded, checkAccount, limitIp } from "../auth/limits.js";
import {
  beginEnrolment,
  checkSecondFactor,
  checkTotp,
  deleteChallenge,
  disableTwoFactor,
  enableTwoFactor,
  pendingSecret,
  recoveryCodesLeft,
  regenerateRecoveryCodes,
  takeChallengeAttempt,
  twoFactorEnabled,
} from "../auth/twofactor.js";
import { otpauthUri } from "../lib/totp.js";
import { audit } from "../services/audit.js";
import { userOut } from "../services/serialize.js";
import { signIn } from "./auth.js";

const ISSUER = "Throwaway Mail";
const code = z.string().trim().min(6).max(20);
export const confirmBody = z
  .object({ password: z.string().max(1000).optional(), code: code.optional() })
  .refine((b) => b.password || b.code, "Give your password or a two-factor code");

export const fresh = (c: Ctx, id: string) => c.get("deps").db.select().from(users).where(eq(users.id, id)).get()!;

export function localMe(c: Ctx): User {
  const me = c.get("user")!;
  if (!isLocalUser(me) || !me.passwordHash)
    throw badRequest("Two-factor authentication of single sign-on accounts is managed by the identity provider");
  return fresh(c, me.id);
}

/** Confirms a sensitive change with the password or a second-factor code; failures count towards the account lockout. */
export async function confirm(c: Ctx, me: User, body: { password?: string; code?: string }) {
  const key = `2fa:${me.id}`;
  checkAccount(c, key);
  const ok = body.code ? !!checkSecondFactor(c.get("deps"), me, body.code) : await verifyPassword(body.password!, me.passwordHash!);
  if (!ok) {
    accountFailed(c, key);
    audit(c.get("deps"), me.id, "auth.2fa_confirm_failed", me.id, undefined, clientIp(c));
    throw new HttpError(403, "invalid_credentials", body.code ? "Wrong code" : "Wrong password");
  }
  accountSucceeded(c, key);
}

/** Optional TOTP second factor of local accounts, with one-time recovery codes. */
export function registerTwoFactor(r: ApiRouter) {
  r.add(
    { method: "get", path: "/v1/auth/2fa", summary: "Two-factor status of the current local account", tags: ["auth"], auth: "user" },
    (c) => {
      const me = localMe(c);
      const d = c.get("deps");
      return c.json({
        enabled: twoFactorEnabled(me),
        enabled_at: me.totpEnabledAt,
        pending: !!pendingSecret(d, me),
        recovery_codes_left: twoFactorEnabled(me) ? recoveryCodesLeft(d, me.id) : 0,
      });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/2fa/setup",
      summary: "Start two-factor enrolment: returns a new TOTP secret and otpauth:// URI (inactive until confirmed)",
      tags: ["auth"],
      auth: "user",
      body: z.object({ password: z.string().max(1000) }),
    },
    async (c, { body }) => {
      limitIp(c);
      const me = localMe(c);
      if (twoFactorEnabled(me)) throw conflict("Two-factor authentication is already on: turn it off first");
      await confirm(c, me, { password: body.password });
      const secret = beginEnrolment(c.get("deps"), me.id);
      return c.json({ secret, otpauth_uri: otpauthUri(secret, me.email, ISSUER) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/2fa/enable",
      summary: "Confirm enrolment with a code from the app; returns the recovery codes (shown once)",
      tags: ["auth"],
      auth: "user",
      body: z.object({ code }),
    },
    (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = localMe(c);
      if (twoFactorEnabled(me)) throw conflict("Two-factor authentication is already on");
      if (!pendingSecret(d, me)) throw badRequest("Start the setup first");
      const key = `2fa:${me.id}`;
      checkAccount(c, key);
      if (!checkTotp(d, me, body.code)) {
        accountFailed(c, key);
        throw new HttpError(403, "invalid_code", "Wrong code: check the time of your device and try the next code");
      }
      accountSucceeded(c, key);
      const codes = enableTwoFactor(d, me.id);
      audit(d, me.id, "user.2fa_enabled", me.id, undefined, clientIp(c));
      return c.json({ recovery_codes: codes });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/2fa/disable",
      summary: "Turn two-factor authentication off (confirm with the password or a code)",
      tags: ["auth"],
      auth: "user",
      body: confirmBody,
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = localMe(c);
      if (twoFactorEnabled(me)) await confirm(c, me, body);
      else if (!me.totpSecret) throw badRequest("Two-factor authentication is not on");
      disableTwoFactor(d, me.id);
      if (twoFactorEnabled(me)) audit(d, me.id, "user.2fa_disabled", me.id, undefined, clientIp(c));
      return c.json({ ok: true });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/2fa/recovery-codes",
      summary: "Replace the recovery codes (confirm with the password or a code); returns the new ones",
      tags: ["auth"],
      auth: "user",
      body: confirmBody,
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = localMe(c);
      if (!twoFactorEnabled(me)) throw badRequest("Two-factor authentication is not on");
      await confirm(c, me, body);
      const codes = regenerateRecoveryCodes(d, me.id);
      audit(d, me.id, "user.2fa_recovery_regenerated", me.id, undefined, clientIp(c));
      return c.json({ recovery_codes: codes });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/login/2fa",
      summary: "Second sign-in step: a TOTP or recovery code for the challenge returned by /v1/auth/login",
      tags: ["auth"],
      auth: "none",
      body: z.object({ challenge: z.string().min(10).max(200), code }),
    },
    (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const ch = takeChallengeAttempt(d, body.challenge);
      if (!ch) throw new HttpError(401, "challenge_expired", "This sign-in expired: enter your password again");
      const key = `2fa:${ch.user.id}`;
      checkAccount(c, key);
      const kind = checkSecondFactor(d, ch.user, body.code);
      if (!kind) {
        accountFailed(c, key);
        audit(d, ch.user.id, "auth.login_failed", ch.user.id, { method: "password", reason: "wrong_2fa_code" }, clientIp(c));
        throw new HttpError(401, "invalid_code", "Wrong code");
      }
      accountSucceeded(c, key);
      deleteChallenge(d, ch.id);
      if (ch.user.disabled) throw new HttpError(403, "account_disabled", "Your account is disabled in this app");
      const user = fresh(c, ch.user.id);
      if (kind === "recovery") audit(d, user.id, "auth.recovery_code_used", user.id, { left: recoveryCodesLeft(d, user.id) }, clientIp(c));
      audit(d, user.id, "auth.login", user.id, { method: "password", second_factor: kind }, clientIp(c));
      const s = signIn(c, user);
      return c.json({ user: userOut(user), csrf_token: s.csrfToken });
    },
  );

  r.add(
    {
      method: "delete",
      path: "/v1/admin/users/:id/2fa",
      summary: "Reset (turn off) the two-factor authentication of a local account",
      tags: ["admin"],
      auth: "admin",
    },
    (c) => {
      const d = c.get("deps");
      const id = c.req.param("id")!;
      const target = d.db.select().from(users).where(eq(users.id, id)).get();
      if (!target) throw notFound("User");
      if (!target.totpSecret && !target.passkeySecondFactor) throw badRequest("This user has no two-factor authentication");
      disableTwoFactor(d, id, true);
      audit(d, c.get("user")!.id, "user.2fa_reset", id, { email: target.email }, clientIp(c));
      return c.json({ user: userOut(fresh(c, id)) });
    },
  );
}
