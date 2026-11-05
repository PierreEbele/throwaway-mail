import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../context.js";
import { HttpError } from "../lib/errors.js";
import { safeEqual } from "../lib/crypto.js";
import { clientIp } from "../lib/http.js";
import { RateLimiter } from "./ratelimit.js";
import { eq } from "drizzle-orm";
import { messages } from "../db/schema.js";
import { SESSION_COOKIE, resolveApiKey, resolveSession, type ApiKeyScope } from "./tokens.js";

/** Resolves the caller from a Bearer API key or the session cookie. Never throws for anonymous callers. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get("deps");
  c.set("user", null);
  c.set("session", null);
  c.set("apiKeyId", null);
  c.set("apiScope", null);
  const authz = c.req.header("authorization");
  if (authz) {
    const m = /^Bearer\s+(\S+)$/i.exec(authz);
    const r = m ? resolveApiKey(deps, m[1]!) : null;
    if (!r) throw new HttpError(401, "invalid_api_key", "Invalid or revoked API key");
    c.set("user", r.user);
    c.set("apiKeyId", r.keyId);
    c.set("apiScope", r.scope);
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    const r = token ? resolveSession(deps, token) : null;
    if (r) {
      c.set("user", r.user);
      c.set("session", { id: r.sessionId, csrfToken: r.csrfToken });
    }
  }
  await next();
};

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookie-authenticated unsafe requests must echo the session CSRF token. API-key requests are exempt. */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get("session");
  if (session && !SAFE.has(c.req.method)) {
    const header = c.req.header("x-csrf-token") ?? "";
    if (!safeEqual(header, session.csrfToken)) throw new HttpError(403, "csrf_failed", "Missing or invalid CSRF token");
  }
  await next();
};

export function rateLimit(limiter: RateLimiter, keyFn: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const r = limiter.hit(keyFn(c));
    c.header("x-ratelimit-remaining", String(r.remaining));
    if (!r.ok) {
      c.header("retry-after", String(r.retryAfter));
      throw new HttpError(429, "rate_limited", `Too many requests, retry in ${r.retryAfter}s`);
    }
    await next();
  };
}

export function callerKey(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string {
  const keyId = c.get("apiKeyId");
  if (keyId) return `key:${keyId}`;
  const user = c.get("user");
  if (user) return `user:${user.id}`;
  return `ip:${clientIp(c)}`;
}

/**
 * Routes an address-restricted key may reach. Anything else (settings, exports, admin, account-wide
 * lists, address creation) is refused, so a new route stays closed to restricted keys until listed here.
 */
const ADDRESS_ROUTES: { method: string; re: RegExp; kind: "list" | "address" | "message" }[] = [
  { method: "GET", re: /^\/v1\/addresses\/?$/, kind: "list" },
  { method: "GET", re: /^\/v1\/events\/?$/, kind: "list" },
  { method: "GET", re: /^\/v1\/auth\/(me|status)\/?$/, kind: "list" },
  { method: "*", re: /^\/v1\/addresses\/(?!bulk(?:\/|$))([^/]+)(?:\/.*)?$/, kind: "address" },
  { method: "*", re: /^\/v1\/messages\/([^/]+)(?:\/.*)?$/, kind: "message" },
];

/** True when the caller may see this address (sessions and unrestricted keys see all of the user's addresses). */
export function scopeAllows(scope: ApiKeyScope | null, addressId: string): boolean {
  return !scope?.addressIds || scope.addressIds.has(addressId);
}

/** Enforces API key scopes: read-only keys cannot write, address-restricted keys only reach their addresses. */
export const enforceScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const scope = c.get("apiScope");
  if (scope) {
    if (scope.readOnly && !SAFE.has(c.req.method)) throw new HttpError(403, "insufficient_scope", "This API key is read-only");
    const ids = scope.addressIds;
    if (ids) {
      const method = c.req.method === "HEAD" ? "GET" : c.req.method;
      const route = ADDRESS_ROUTES.map((r) => ({ r, m: r.method === "*" || r.method === method ? r.re.exec(c.req.path) : null })).find(
        (x) => x.m,
      );
      if (!route) throw new HttpError(403, "insufficient_scope", "This API key is restricted to some addresses");
      const id = route.m![1] ? decodeURIComponent(route.m![1]) : "";
      let allowed = route.r.kind === "list";
      if (route.r.kind === "address") allowed = ids.has(id);
      if (route.r.kind === "message") {
        const row = c.get("deps").db.select({ a: messages.addressId }).from(messages).where(eq(messages.id, id)).get();
        allowed = !!row && ids.has(row.a);
      }
      // Out-of-scope ids look missing, like another user's address.
      if (!allowed) throw new HttpError(404, "not_found", "Not found");
    }
  }
  await next();
};
