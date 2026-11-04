import { and, eq, isNull, lt } from "drizzle-orm";
import type { Deps } from "../context.js";
import { loginChallenges, recoveryCodes, users, type User } from "../db/schema.js";
import { newId, randomString, randomToken, sha256 } from "../lib/crypto.js";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { newTotpSecret, verifyTotp } from "../lib/totp.js";

export const RECOVERY_CODE_COUNT = 10;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;

export const twoFactorEnabled = (u: User) => u.totpEnabledAt !== null && !!u.totpSecret;

/** Encrypted with APP_SECRET when it is set; kept in plain base32 otherwise (see docs/configuration.md). */
function sealSecret(d: Deps, plain: string) {
  return d.config.APP_SECRET ? encryptSecret(d.config.APP_SECRET, plain) : plain;
}

function openSecret(d: Deps, stored: string) {
  if (!stored.startsWith("v1:")) return stored;
  if (!d.config.APP_SECRET) throw new Error("The two-factor secret is encrypted but APP_SECRET is not set");
  return decryptSecret(d.config.APP_SECRET, stored);
}

/** Starts (or restarts) enrolment: a new secret that only becomes active after enable(). Returns the plain secret. */
export function beginEnrolment(d: Deps, userId: string): string {
  const secret = newTotpSecret();
  d.db
    .update(users)
    .set({ totpSecret: sealSecret(d, secret), totpEnabledAt: null, totpLastStep: null })
    .where(eq(users.id, userId))
    .run();
  return secret;
}

export function pendingSecret(d: Deps, user: User): string | null {
  return user.totpSecret && user.totpEnabledAt === null ? openSecret(d, user.totpSecret) : null;
}

/** Checks a TOTP code (refusing replays) and records its step. */
export function checkTotp(d: Deps, user: User, code: string): boolean {
  if (!user.totpSecret) return false;
  const step = verifyTotp(openSecret(d, user.totpSecret), code, d.now(), user.totpLastStep);
  if (step === null) return false;
  d.db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id)).run();
  return true;
}

const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Uses up a recovery code; false when unknown or already used. */
export function useRecoveryCode(d: Deps, user: User, code: string): boolean {
  const norm = normalizeRecovery(code);
  if (norm.length !== 10) return false;
  const res = d.db
    .update(recoveryCodes)
    .set({ usedAt: d.now() })
    .where(and(eq(recoveryCodes.userId, user.id), eq(recoveryCodes.codeHash, sha256(norm)), isNull(recoveryCodes.usedAt)))
    .run();
  return res.changes > 0;
}

/** A TOTP code or a recovery code. */
export function checkSecondFactor(d: Deps, user: User, code: string): "totp" | "recovery" | null {
  if (!twoFactorEnabled(user)) return null;
  if (/^\s*\d{3}\s?\d{3}\s*$/.test(code)) return checkTotp(d, user, code) ? "totp" : null;
  return useRecoveryCode(d, user, code) ? "recovery" : null;
}

/** Replaces every recovery code; returns the new ones (shown once). */
export function regenerateRecoveryCodes(d: Deps, userId: string): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomString(10));
  const now = d.now();
  d.db.transaction((tx) => {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    for (const c of codes)
      tx.insert(recoveryCodes)
        .values({ id: newId("rec"), userId, codeHash: sha256(c), createdAt: now })
        .run();
  });
  return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
}

export function recoveryCodesLeft(d: Deps, userId: string): number {
  return d.db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .all().length;
}

export function enableTwoFactor(d: Deps, userId: string): string[] {
  d.db.update(users).set({ totpEnabledAt: d.now() }).where(eq(users.id, userId)).run();
  return regenerateRecoveryCodes(d, userId);
}

export function disableTwoFactor(d: Deps, userId: string) {
  d.db.transaction((tx) => {
    tx.update(users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null }).where(eq(users.id, userId)).run();
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    tx.delete(loginChallenges).where(eq(loginChallenges.userId, userId)).run();
  });
}

/** After a correct password: a short-lived token for the code step. */
export function createChallenge(d: Deps, userId: string): string {
  const token = randomToken();
  const now = d.now();
  d.db.delete(loginChallenges).where(lt(loginChallenges.expiresAt, now)).run();
  d.db
    .insert(loginChallenges)
    .values({ id: sha256(token), userId, createdAt: now, expiresAt: now + CHALLENGE_TTL_MS })
    .run();
  return token;
}

/** Live challenge for a token (counting this attempt), or null when unknown, expired or out of attempts. */
export function takeChallengeAttempt(d: Deps, token: string): { id: string; user: User } | null {
  const id = sha256(token);
  const ch = d.db.select().from(loginChallenges).where(eq(loginChallenges.id, id)).get();
  if (!ch || ch.expiresAt <= d.now() || ch.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    if (ch) d.db.delete(loginChallenges).where(eq(loginChallenges.id, id)).run();
    return null;
  }
  d.db
    .update(loginChallenges)
    .set({ attempts: ch.attempts + 1 })
    .where(eq(loginChallenges.id, id))
    .run();
  const user = d.db.select().from(users).where(eq(users.id, ch.userId)).get();
  return user ? { id, user } : null;
}

export function deleteChallenge(d: Deps, id: string) {
  d.db.delete(loginChallenges).where(eq(loginChallenges.id, id)).run();
}
