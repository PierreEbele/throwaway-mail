import { and, eq, gt, isNull } from "drizzle-orm";
import type { Deps } from "../context.js";
import { apiKeys, sessions, users, type User } from "../db/schema.js";
import { newId, randomString, randomToken, sha256 } from "../lib/crypto.js";

export const SESSION_COOKIE = "tm_session";

export function createSession(deps: Deps, userId: string) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = deps.now();
  const expiresAt = now + deps.config.SESSION_TTL_DAYS * 86400_000;
  deps.db
    .insert(sessions)
    .values({ id: sha256(token), userId, csrfToken, createdAt: now, expiresAt })
    .run();
  return { token, csrfToken, expiresAt };
}

export function resolveSession(deps: Deps, token: string): { user: User; sessionId: string; csrfToken: string } | null {
  const row = deps.db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, deps.now())))
    .get();
  if (!row || row.u.disabled) return null;
  return { user: row.u, sessionId: row.s.id, csrfToken: row.s.csrfToken };
}

export function deleteSession(deps: Deps, sessionId: string) {
  deps.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

/** API keys look like tm_<prefix>_<secret>; only the SHA-256 of the whole key is stored. */
export interface ApiKeyOptions {
  scope?: "full" | "read";
  addressIds?: string[] | null;
  expiresAt?: number | null;
}

/** What an API key may do. Session callers have no scope (unrestricted). */
export interface ApiKeyScope {
  readOnly: boolean;
  /** Address ids the key is limited to; null means every address of the user. */
  addressIds: ReadonlySet<string> | null;
}

export function createApiKey(deps: Deps, userId: string, name: string, opts: ApiKeyOptions = {}) {
  const prefix = randomString(8);
  const key = `tm_${prefix}_${randomToken(32)}`;
  const row = {
    id: newId("key"),
    userId,
    name,
    keyHash: sha256(key),
    prefix: `tm_${prefix}`,
    createdAt: deps.now(),
    scope: opts.scope ?? "full",
    addressIds: opts.addressIds && opts.addressIds.length ? [...new Set(opts.addressIds)] : null,
    expiresAt: opts.expiresAt ?? null,
  };
  deps.db.insert(apiKeys).values(row).run();
  return { key, row };
}

export function resolveApiKey(deps: Deps, key: string): { user: User; keyId: string; scope: ApiKeyScope } | null {
  if (!key.startsWith("tm_")) return null;
  const row = deps.db
    .select({ k: apiKeys, u: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, sha256(key)), isNull(apiKeys.revokedAt)))
    .get();
  if (!row || row.u.disabled) return null;
  const now = deps.now();
  if (row.k.expiresAt != null && row.k.expiresAt <= now) return null;
  if (!row.k.lastUsedAt || now - row.k.lastUsedAt > 60_000) {
    deps.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.k.id)).run();
  }
  const scope: ApiKeyScope = {
    readOnly: row.k.scope === "read",
    addressIds: row.k.addressIds ? new Set(row.k.addressIds) : null,
  };
  return { user: row.u, keyId: row.k.id, scope };
}
