import { and, eq, gt, isNull } from "drizzle-orm";
import type { Deps } from "../context.js";
import { invites, users, type User } from "../db/schema.js";
import { newId, randomToken, sha256 } from "../lib/crypto.js";
import { conflict } from "../lib/errors.js";

export const INVITE_TTL_MS = 7 * 86400_000;

export type Invite = typeof invites.$inferSelect;
type Role = User["role"];

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function findUserByEmail(deps: Deps, email: string): User | undefined {
  return deps.db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .get();
}

/** A local account: no OpenID Connect subject (it signs in with a password). */
export const isLocalUser = (u: User) => u.oidcSub === null;

/**
 * Invites create a local account. An invite for the e-mail of an existing local account is a password reset link:
 * accepting it sets a new password on that account. SSO accounts cannot be invited or reset.
 */
export function createInvite(deps: Deps, email: string, role: Role, createdBy: string) {
  const normalized = normalizeEmail(email);
  const existing = findUserByEmail(deps, normalized);
  if (existing && !isLocalUser(existing)) throw conflict("This e-mail belongs to a single sign-on account");
  const token = randomToken(32);
  const now = deps.now();
  const row: Invite = {
    id: newId("inv"),
    tokenHash: sha256(token),
    email: normalized,
    role: existing?.role ?? role,
    createdBy,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    usedAt: null,
  };
  deps.db.transaction((tx) => {
    // Only the latest link for an e-mail stays valid.
    tx.delete(invites)
      .where(and(eq(invites.email, normalized), isNull(invites.usedAt)))
      .run();
    tx.insert(invites).values(row).run();
  });
  return { invite: row, token, reset: !!existing };
}

export function pendingInvites(deps: Deps): Invite[] {
  return deps.db
    .select()
    .from(invites)
    .where(and(isNull(invites.usedAt), gt(invites.expiresAt, deps.now())))
    .orderBy(invites.createdAt)
    .all();
}

/** The invite for a token if it is neither used nor expired. */
export function validInvite(deps: Deps, token: string): Invite | null {
  const row = deps.db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, sha256(token)))
    .get();
  if (!row || row.usedAt !== null || row.expiresAt <= deps.now()) return null;
  return row;
}

export function inviteUrl(deps: Deps, token: string) {
  return `${deps.config.APP_URL.replace(/\/$/, "")}/invite/${token}`;
}
