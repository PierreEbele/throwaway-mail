import { eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { ApiRouter, Ctx } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { users, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { SESSION_COOKIE, createSession, deleteSession } from "../auth/tokens.js";
import { RateLimiter } from "../auth/ratelimit.js";
import type { SsoIdentity } from "../auth/oidc.js";
import type { Deps } from "../context.js";
import { audit } from "../services/audit.js";
import { userOut } from "../services/serialize.js";

const STATE_COOKIE = "tm_oidc_state";

/** Create or update the local user for an SSO identity. Throws if the user may not log in. */
export function upsertSsoUser(deps: Deps, id: SsoIdentity, ip: string | null): User {
  const cfg = deps.config;
  if (cfg.oidcAllowedGroups.length && !id.groups.some((g) => cfg.oidcAllowedGroups.includes(g))) {
    throw new HttpError(403, "sso_not_allowed", "Your account is not in a group allowed to use this app");
  }
  const role = id.groups.includes(cfg.OIDC_ADMIN_GROUP) ? ("admin" as const) : ("user" as const);
  const now = deps.now();
  const existing = deps.db.select().from(users).where(eq(users.oidcSub, id.sub)).get();
  if (existing) {
    if (existing.disabled) throw new HttpError(403, "account_disabled", "Your account is disabled in this app");
    deps.db.update(users).set({ email: id.email, name: id.name, role, lastLoginAt: now }).where(eq(users.id, existing.id)).run();
    if (existing.role !== role) audit(deps, existing.id, "user.role_synced", existing.id, { from: existing.role, to: role }, ip);
    return deps.db.select().from(users).where(eq(users.id, existing.id)).get()!;
  }
  const row = { id: newId("usr"), oidcSub: id.sub, email: id.email, name: id.name, role, createdAt: now, lastLoginAt: now };
  deps.db.insert(users).values(row).run();
  audit(deps, row.id, "user.created_via_sso", row.id, { email: row.email, role }, ip);
  return deps.db.select().from(users).where(eq(users.id, row.id)).get()!;
}

function loginRedirect(c: Ctx, code: string, message: string) {
  const u = new URLSearchParams({ error: code, message });
  return c.redirect(`/login?${u}`, 302);
}

export function registerAuth(r: ApiRouter) {
  let limiter: RateLimiter | null = null;
  const limit = (c: Ctx) => {
    limiter ??= new RateLimiter(c.get("deps").config.LOGIN_RATE_LIMIT_PER_MINUTE);
    const res = limiter.hit(`sso:${clientIp(c)}`);
    if (!res.ok) {
      c.header("retry-after", String(res.retryAfter));
      throw new HttpError(429, "rate_limited", `Too many attempts, retry in ${res.retryAfter}s`);
    }
  };

  r.add({ method: "get", path: "/v1/auth/status", summary: "Login method and Cloudflare mode", tags: ["auth"], auth: "none" }, (c) => {
    const d = c.get("deps");
    return c.json({ sso: { enabled: d.oidc.enabled, provider: d.oidc.providerName }, cloudflare_mode: d.cf.mode });
  });

  r.add(
    {
      method: "get",
      path: "/v1/auth/oidc/login",
      summary: "Start single sign-on (redirects to the identity provider)",
      tags: ["auth"],
      auth: "none",
      query: z.object({ return_to: z.string().max(500).optional() }),
      responses: { 302: "Redirect to the identity provider" },
    },
    async (c, { query }) => {
      limit(c);
      const d = c.get("deps");
      try {
        const { url, state } = await d.oidc.start(query.return_to ?? "/");
        setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: d.config.cookieSecure, sameSite: "Lax", path: "/v1/auth/oidc", maxAge: 600 });
        return c.redirect(url, 302);
      } catch (e) {
        if (e instanceof HttpError) return loginRedirect(c, e.code, e.message);
        throw e;
      }
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/auth/oidc/callback",
      summary: "Single sign-on callback (sets the session cookie)",
      tags: ["auth"],
      auth: "none",
      responses: { 302: "Redirect into the app, or to /login with an error" },
    },
    async (c) => {
      limit(c);
      const d = c.get("deps");
      const url = new URL(c.req.url);
      const browserState = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: "/v1/auth/oidc" });
      const idpError = url.searchParams.get("error");
      if (idpError) return loginRedirect(c, idpError, url.searchParams.get("error_description") ?? "The identity provider refused the sign-in");
      try {
        const { identity, returnTo } = await d.oidc.finish(url, browserState);
        const user = upsertSsoUser(d, identity, clientIp(c));
        const s = createSession(d, user.id);
        setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, secure: d.config.cookieSecure, sameSite: "Lax", path: "/", expires: new Date(s.expiresAt) });
        d.logger.info("sso login", { user_id: user.id, role: user.role });
        return c.redirect(returnTo, 302);
      } catch (e) {
        if (e instanceof HttpError) {
          d.logger.info("sso login refused", { code: e.code, ip: clientIp(c) });
          return loginRedirect(c, e.code, e.message);
        }
        throw e;
      }
    },
  );

  r.add({ method: "post", path: "/v1/auth/logout", summary: "Log out of this app", tags: ["auth"], auth: "user" }, (c) => {
    const s = c.get("session");
    if (s) deleteSession(c.get("deps"), s.id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  r.add({ method: "get", path: "/v1/auth/me", summary: "Current user (and CSRF token for browser sessions)", tags: ["auth"], auth: "user" }, (c) => {
    return c.json({ user: userOut(c.get("user")!), csrf_token: c.get("session")?.csrfToken ?? null, auth: c.get("apiKeyId") ? "api_key" : "session" });
  });
}
