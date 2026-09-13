import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../context.js";
import { HttpError } from "../lib/errors.js";
import { safeEqual } from "../lib/crypto.js";
import { clientIp } from "../lib/http.js";
import { RateLimiter } from "./ratelimit.js";
import { SESSION_COOKIE, resolveApiKey, resolveSession } from "./tokens.js";

/** Resolves the caller from a Bearer API key or the session cookie. Never throws for anonymous callers. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get("deps");
  c.set("user", null);
  c.set("session", null);
  c.set("apiKeyId", null);
  const authz = c.req.header("authorization");
  if (authz) {
    const m = /^Bearer\s+(\S+)$/i.exec(authz);
    const r = m ? resolveApiKey(deps, m[1]!) : null;
    if (!r) throw new HttpError(401, "invalid_api_key", "Invalid or revoked API key");
    c.set("user", r.user);
    c.set("apiKeyId", r.keyId);
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
