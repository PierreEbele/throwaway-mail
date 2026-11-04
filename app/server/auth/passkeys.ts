import { and, asc, eq, lt } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Deps } from "../context.js";
import { passkeys, recoveryCodes, users, webauthnChallenges, type Passkey, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { twoFactorEnabled } from "./twofactor.js";

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_PASSKEYS = 20;
type Purpose = (typeof webauthnChallenges.$inferSelect)["purpose"];

/**
 * Relying party for a request: the app origin it came from (APP_URL or one of APP_EXTRA_URLS), so passkeys work on
 * every public URL of the app. A passkey is bound to the host name it was created on.
 */
export function relyingParty(d: Deps, requestOrigin: string | undefined | null) {
  const origins = d.config.appOrigins;
  const origin = requestOrigin && origins.includes(requestOrigin) ? requestOrigin : origins[0]!;
  return { origin, rpID: new URL(origin).hostname, origins, rpIDs: [...new Set(origins.map((o) => new URL(o).hostname))] };
}

export function listPasskeys(d: Deps, userId: string): Passkey[] {
  return d.db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt)).all();
}

export const passkeyOut = (p: Passkey) => ({
  id: p.id,
  name: p.name,
  created_at: p.createdAt,
  last_used_at: p.lastUsedAt,
  /** Synced passkey (iCloud Keychain, Google Password Manager, a password manager...) vs. a single device. */
  synced: p.backedUp,
});

/** A second factor is asked after the password: TOTP turned on, or "passkey after password" with at least one passkey. */
export function secondFactorRequired(d: Deps, user: User): boolean {
  return twoFactorEnabled(user) || (user.passkeySecondFactor && listPasskeys(d, user.id).length > 0);
}

function saveChallenge(d: Deps, challenge: string, purpose: Purpose, userId: string | null) {
  const now = d.now();
  d.db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now)).run();
  d.db
    .insert(webauthnChallenges)
    .values({ id: challenge, userId, purpose, createdAt: now, expiresAt: now + WEBAUTHN_CHALLENGE_TTL_MS })
    .run();
}

/** The challenge the browser signed, if it is one we issued for this purpose (and user); consumed either way. */
function takeChallenge(d: Deps, clientDataJSON: string, purpose: Purpose, userId: string | null): string | null {
  let challenge: string;
  try {
    challenge = String(JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")).challenge ?? "");
  } catch {
    return null;
  }
  if (!challenge) return null;
  const row = d.db.select().from(webauthnChallenges).where(eq(webauthnChallenges.id, challenge)).get();
  if (!row) return null;
  d.db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, challenge)).run();
  if (row.purpose !== purpose || row.expiresAt <= d.now() || row.userId !== userId) return null;
  return challenge;
}

const transportsOf = (p: Passkey) => (p.transportsJson ? (JSON.parse(p.transportsJson) as AuthenticatorTransport[]) : undefined);

export async function registrationOptions(d: Deps, user: User, origin: string | undefined) {
  const rp = relyingParty(d, origin);
  const options = await generateRegistrationOptions({
    rpName: "Throwaway Mail",
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: listPasskeys(d, user.id).map((p) => ({ id: p.credentialId, transports: transportsOf(p) })),
    // Discoverable credentials, so the passkey can sign in without typing the e-mail.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  saveChallenge(d, options.challenge, "register", user.id);
  return options;
}

export async function registerPasskey(d: Deps, user: User, response: RegistrationResponseJSON, name: string): Promise<Passkey | null> {
  const challenge = takeChallenge(d, response.response?.clientDataJSON ?? "", "register", user.id);
  if (!challenge) return null;
  const rp = relyingParty(d, null);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpIDs,
      requireUserVerification: true,
    });
  } catch (e) {
    d.logger.info("passkey registration refused", { err: (e as Error).message });
    return null;
  }
  if (!v.verified || !v.registrationInfo) return null;
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  if (d.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, credential.id)).get()) return null;
  const row = {
    id: newId("pk"),
    userId: user.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transportsJson: credential.transports?.length ? JSON.stringify(credential.transports) : null,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    name,
    createdAt: d.now(),
  };
  d.db.insert(passkeys).values(row).run();
  return d.db.select().from(passkeys).where(eq(passkeys.id, row.id)).get()!;
}

/** Options for a sign-in: usernameless (no user: any discoverable passkey) or the second factor of `user`. */
export async function authenticationOptions(d: Deps, user: User | null, origin: string | undefined) {
  const rp = relyingParty(d, origin);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: user ? "preferred" : "required",
    allowCredentials: user ? listPasskeys(d, user.id).map((p) => ({ id: p.credentialId, transports: transportsOf(p) })) : [],
  });
  saveChallenge(d, options.challenge, user ? "second_factor" : "login", user?.id ?? null);
  return options;
}

export type PasskeyCheck = { ok: true; user: User; passkey: Passkey } | { ok: false; user: User | null; reason: string };

/**
 * Verifies an assertion. Usernameless sign-in (`expectedUser` null) requires user verification (PIN, biometrics):
 * the passkey alone is then two factors. As a second factor after the password, presence is enough.
 */
export async function verifyPasskey(d: Deps, response: AuthenticationResponseJSON, expectedUser: User | null): Promise<PasskeyCheck> {
  const purpose: Purpose = expectedUser ? "second_factor" : "login";
  const challenge = takeChallenge(d, response.response?.clientDataJSON ?? "", purpose, expectedUser?.id ?? null);
  const pk = typeof response.id === "string" ? d.db.select().from(passkeys).where(eq(passkeys.credentialId, response.id)).get() : undefined;
  const owner = pk ? (d.db.select().from(users).where(eq(users.id, pk.userId)).get() ?? null) : null;
  if (!challenge) return { ok: false, user: expectedUser ?? owner, reason: "unknown_challenge" };
  if (!pk || !owner) return { ok: false, user: expectedUser, reason: "unknown_passkey" };
  if (expectedUser && owner.id !== expectedUser.id) return { ok: false, user: expectedUser, reason: "unknown_passkey" };
  const rp = relyingParty(d, null);
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpIDs,
      credential: {
        id: pk.credentialId,
        publicKey: Buffer.from(pk.publicKey, "base64url"),
        counter: pk.counter,
        transports: transportsOf(pk),
      },
      requireUserVerification: !expectedUser,
    });
    if (!v.verified) return { ok: false, user: owner, reason: "bad_signature" };
    d.db
      .update(passkeys)
      .set({ counter: v.authenticationInfo.newCounter, backedUp: v.authenticationInfo.credentialBackedUp, lastUsedAt: d.now() })
      .where(eq(passkeys.id, pk.id))
      .run();
    return { ok: true, user: owner, passkey: pk };
  } catch (e) {
    d.logger.info("passkey assertion refused", { err: (e as Error).message });
    return { ok: false, user: owner, reason: "bad_signature" };
  }
}

/** Removes a passkey. Without passkeys left, "passkey after password" turns itself off (with its recovery codes unless TOTP uses them). */
export function removePasskey(d: Deps, user: User, id: string): boolean {
  const res = d.db
    .delete(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
    .run();
  if (!res.changes) return false;
  if (user.passkeySecondFactor && !listPasskeys(d, user.id).length) setPasskeySecondFactor(d, user, false);
  return true;
}

export function setPasskeySecondFactor(d: Deps, user: User, enabled: boolean) {
  d.db.transaction((tx) => {
    tx.update(users).set({ passkeySecondFactor: enabled }).where(eq(users.id, user.id)).run();
    if (!enabled && !twoFactorEnabled(user)) tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run();
  });
}
