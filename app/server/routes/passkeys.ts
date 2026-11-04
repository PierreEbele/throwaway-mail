import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { passkeys } from "../db/schema.js";
import { HttpError, badRequest, conflict, notFound } from "../lib/errors.js";
import { accountFailed, accountSucceeded, checkAccount, limitIp } from "../auth/limits.js";
import {
  MAX_PASSKEYS,
  authenticationOptions,
  listPasskeys,
  passkeyOut,
  registerPasskey,
  registrationOptions,
  removePasskey,
  setPasskeySecondFactor,
  verifyPasskey,
} from "../auth/passkeys.js";
import { deleteChallenge, recoveryCodesLeft, regenerateRecoveryCodes, takeChallengeAttempt, twoFactorEnabled } from "../auth/twofactor.js";
import { audit } from "../services/audit.js";
import { userOut } from "../services/serialize.js";
import { signIn } from "./auth.js";
import { confirm, confirmBody, fresh, localMe } from "./twofactor.js";

/** Browser credential JSON (from @simplewebauthn/browser); checked in depth by @simplewebauthn/server. */
const credential = z.looseObject({
  id: z.string().min(1).max(1500),
  rawId: z.string().min(1).max(1500),
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: z.string().max(10_000) }),
});
const passkeyName = z.string().trim().min(1).max(60);

/** Passkeys (WebAuthn) of local accounts: optional sign-in without a password, or second factor after it. */
export function registerPasskeys(r: ApiRouter) {
  r.add(
    { method: "get", path: "/v1/auth/passkeys", summary: "Passkeys of the current local account", tags: ["auth"], auth: "user" },
    (c) => {
      const me = localMe(c);
      const d = c.get("deps");
      return c.json({
        passkeys: listPasskeys(d, me.id).map(passkeyOut),
        second_factor: me.passkeySecondFactor,
        recovery_codes_left: me.passkeySecondFactor || twoFactorEnabled(me) ? recoveryCodesLeft(d, me.id) : 0,
      });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/passkeys/options",
      summary: "Start adding a passkey (confirm with the password or a two-factor code); returns WebAuthn creation options",
      tags: ["auth"],
      auth: "user",
      body: confirmBody,
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = localMe(c);
      if (listPasskeys(d, me.id).length >= MAX_PASSKEYS) throw conflict(`At most ${MAX_PASSKEYS} passkeys per account`);
      await confirm(c, me, body);
      return c.json({ options: await registrationOptions(d, me, c.req.header("origin")) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/passkeys",
      summary: "Finish adding a passkey with the browser's attestation",
      tags: ["auth"],
      auth: "user",
      body: z.object({ response: credential, name: passkeyName.default("Passkey") }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = localMe(c);
      const pk = await registerPasskey(d, me, body.response as unknown as RegistrationResponseJSON, body.name);
      if (!pk) throw badRequest("The passkey could not be verified: start again");
      audit(d, me.id, "user.passkey_added", me.id, { passkey: pk.id, name: pk.name }, clientIp(c));
      return c.json({ passkey: passkeyOut(pk) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/auth/passkeys/:id",
      summary: "Rename a passkey",
      tags: ["auth"],
      auth: "user",
      body: z.object({ name: passkeyName }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const me = localMe(c);
      const res = d.db
        .update(passkeys)
        .set({ name: body.name })
        .where(and(eq(passkeys.id, c.req.param("id")!), eq(passkeys.userId, me.id)))
        .run();
      if (!res.changes) throw notFound("Passkey");
      return c.json({
        passkey: passkeyOut(
          d.db
            .select()
            .from(passkeys)
            .where(eq(passkeys.id, c.req.param("id")!))
            .get()!,
        ),
      });
    },
  );

  r.add(
    {
      method: "delete",
      path: "/v1/auth/passkeys/:id",
      summary: "Remove a passkey (confirm with the password or a two-factor code)",
      tags: ["auth"],
      auth: "user",
      body: confirmBody,
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = localMe(c);
      const id = c.req.param("id")!;
      if (
        !d.db
          .select({ id: passkeys.id })
          .from(passkeys)
          .where(and(eq(passkeys.id, id), eq(passkeys.userId, me.id)))
          .get()
      )
        throw notFound("Passkey");
      await confirm(c, me, body);
      removePasskey(d, me, id);
      audit(d, me.id, "user.passkey_removed", me.id, { passkey: id }, clientIp(c));
      return c.json({ ok: true, second_factor: fresh(c, me.id).passkeySecondFactor });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/passkeys/second-factor",
      summary: "Ask (or stop asking) for a passkey after the password; returns recovery codes when they are created",
      tags: ["auth"],
      auth: "user",
      body: z
        .object({ enabled: z.boolean(), password: z.string().max(1000).optional(), code: z.string().trim().min(6).max(20).optional() })
        .refine((b) => b.password || b.code, "Give your password or a two-factor code"),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const me = localMe(c);
      if (body.enabled === me.passkeySecondFactor) return c.json({ second_factor: me.passkeySecondFactor, recovery_codes: null });
      if (body.enabled && !listPasskeys(d, me.id).length) throw badRequest("Add a passkey first");
      await confirm(c, me, body);
      setPasskeySecondFactor(d, me, body.enabled);
      // Recovery codes back up the passkey (shared with TOTP when both are on).
      const codes = body.enabled && !twoFactorEnabled(me) ? regenerateRecoveryCodes(d, me.id) : null;
      audit(d, me.id, body.enabled ? "user.2fa_enabled" : "user.2fa_disabled", me.id, { method: "passkey" }, clientIp(c));
      return c.json({ second_factor: body.enabled, recovery_codes: codes });
    },
  );

  // ---------- Sign-in ----------

  r.add(
    {
      method: "post",
      path: "/v1/auth/passkey/options",
      summary: "Start a passkey sign-in (usernameless): returns WebAuthn request options",
      tags: ["auth"],
      auth: "none",
    },
    async (c) => {
      limitIp(c);
      return c.json({ options: await authenticationOptions(c.get("deps"), null, c.req.header("origin")) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/passkey/login",
      summary: "Sign in with a passkey (sets the session cookie); no password or second factor needed",
      tags: ["auth"],
      auth: "none",
      body: z.object({ response: credential }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const accountKey = `passkey:${body.response.id}`;
      checkAccount(c, accountKey);
      const res = await verifyPasskey(d, body.response as unknown as AuthenticationResponseJSON, null);
      if (!res.ok) {
        accountFailed(c, accountKey);
        audit(d, res.user?.id ?? null, "auth.login_failed", res.user?.id ?? null, { method: "passkey", reason: res.reason }, clientIp(c));
        throw new HttpError(401, "invalid_credentials", "This passkey was not accepted");
      }
      accountSucceeded(c, accountKey);
      if (res.user.disabled) {
        audit(d, res.user.id, "auth.login_failed", res.user.email, { method: "passkey", reason: "account_disabled" }, clientIp(c));
        throw new HttpError(403, "account_disabled", "Your account is disabled in this app");
      }
      audit(d, res.user.id, "auth.login", res.user.id, { method: "passkey", passkey: res.passkey.id }, clientIp(c));
      const s = signIn(c, res.user);
      return c.json({ user: userOut(res.user), csrf_token: s.csrfToken });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/login/passkey/options",
      summary: "Second sign-in step with a passkey: WebAuthn request options for the challenge returned by /v1/auth/login",
      tags: ["auth"],
      auth: "none",
      body: z.object({ challenge: z.string().min(10).max(200) }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const ch = takeChallengeAttempt(d, body.challenge);
      if (!ch) throw new HttpError(401, "challenge_expired", "This sign-in expired: enter your password again");
      if (!listPasskeys(d, ch.user.id).length) throw badRequest("This account has no passkey");
      return c.json({ options: await authenticationOptions(d, ch.user, c.req.header("origin")) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/auth/login/passkey",
      summary: "Second sign-in step: a passkey assertion for the challenge returned by /v1/auth/login",
      tags: ["auth"],
      auth: "none",
      body: z.object({ challenge: z.string().min(10).max(200), response: credential }),
    },
    async (c, { body }) => {
      limitIp(c);
      const d = c.get("deps");
      const ch = takeChallengeAttempt(d, body.challenge);
      if (!ch) throw new HttpError(401, "challenge_expired", "This sign-in expired: enter your password again");
      const key = `2fa:${ch.user.id}`;
      checkAccount(c, key);
      const res = await verifyPasskey(d, body.response as unknown as AuthenticationResponseJSON, ch.user);
      if (!res.ok) {
        accountFailed(c, key);
        audit(d, ch.user.id, "auth.login_failed", ch.user.id, { method: "password", reason: "wrong_passkey" }, clientIp(c));
        throw new HttpError(401, "invalid_code", "This passkey was not accepted");
      }
      accountSucceeded(c, key);
      deleteChallenge(d, ch.id);
      if (ch.user.disabled) throw new HttpError(403, "account_disabled", "Your account is disabled in this app");
      const user = fresh(c, ch.user.id);
      audit(d, user.id, "auth.login", user.id, { method: "password", second_factor: "passkey" }, clientIp(c));
      const s = signIn(c, user);
      return c.json({ user: userOut(user), csrf_token: s.csrfToken });
    },
  );
}
