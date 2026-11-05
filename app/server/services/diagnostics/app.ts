import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { users } from "../../db/schema.js";
import { DEFAULT_INGEST_SECRET, TIMEOUT_MS, msg, type Check } from "./types.js";
export async function appUrlChecks(deps: Deps): Promise<Check[]> {
  const { config } = deps;
  const out: Check[] = [];
  const https = config.APP_URL.startsWith("https://");
  out.push(
    https
      ? { id: "app_url.https", group: "app", title: "APP_URL uses HTTPS", status: "ok", detail: config.APP_URL }
      : {
          id: "app_url.https",
          group: "app",
          title: "APP_URL uses HTTPS",
          status: config.isProd ? "error" : "warn",
          detail: `APP_URL is ${config.APP_URL}`,
          hint: "Set APP_URL to the public https:// address of the app (Caddy or your reverse proxy provides TLS). Session cookies are only Secure over HTTPS, and single sign-on providers require it.",
        },
  );
  for (const origin of config.appOrigins) {
    const url = `${origin}/healthz`;
    try {
      const res = await deps.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
      out.push(
        res.ok
          ? {
              id: `app_url.reachable:${origin}`,
              group: "app",
              title: `${origin} is reachable`,
              status: "ok",
              detail: `GET ${url} → ${res.status}`,
            }
          : {
              id: `app_url.reachable:${origin}`,
              group: "app",
              title: `${origin} is reachable`,
              status: "warn",
              detail: `GET ${url} → HTTP ${res.status}`,
              hint: "The URL answers but not with this app. Check that the reverse proxy forwards this host name to the app (and does not put a login page such as Authelia's forward_auth in front of it).",
            },
      );
    } catch (e) {
      out.push({
        id: `app_url.reachable:${origin}`,
        group: "app",
        title: `${origin} is reachable`,
        status: "warn",
        detail: `GET ${url} failed: ${msg(e)}`,
        hint: "The server could not reach its own public URL. Check the DNS record of this host name and the reverse proxy. If it works from your browser, the server's network just cannot loop back to itself (hairpin NAT) and you can ignore this.",
      });
    }
  }
  return out;
}

export async function signInChecks(deps: Deps): Promise<Check[]> {
  const { config, db } = deps;
  const out: Check[] = [];
  if (config.oidcEnabled) {
    const discovery = `${config.OIDC_ISSUER!.replace(/\/$/, "")}/.well-known/openid-configuration`;
    try {
      const res = await deps.fetch(discovery, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = res.ok ? ((await res.json().catch(() => null)) as { issuer?: string } | null) : null;
      if (!res.ok || !body?.issuer)
        out.push({
          id: "oidc.discovery",
          group: "sign-in",
          title: "Single sign-on provider",
          status: "error",
          detail: `GET ${discovery} → ${res.ok ? "not an OpenID configuration" : `HTTP ${res.status}`}`,
          hint: "OIDC_ISSUER must be the issuer URL of your identity provider (e.g. https://auth.example.com for Authelia), without /.well-known/….",
        });
      else if (body.issuer.replace(/\/$/, "") !== config.OIDC_ISSUER!.replace(/\/$/, ""))
        out.push({
          id: "oidc.discovery",
          group: "sign-in",
          title: "Single sign-on provider",
          status: "error",
          detail: `The provider announces issuer ${body.issuer}, OIDC_ISSUER is ${config.OIDC_ISSUER}`,
          hint: "Set OIDC_ISSUER to exactly the issuer the provider announces, otherwise sign-in fails token validation.",
        });
      else
        out.push({
          id: "oidc.discovery",
          group: "sign-in",
          title: "Single sign-on provider",
          status: "ok",
          detail: `${config.OIDC_PROVIDER_NAME} at ${config.OIDC_ISSUER} answers; redirect URI ${config.appOrigins.map((o) => `${o}/v1/auth/oidc/callback`).join(", ")}`,
        });
    } catch (e) {
      out.push({
        id: "oidc.discovery",
        group: "sign-in",
        title: "Single sign-on provider",
        status: "error",
        detail: `GET ${discovery} failed: ${msg(e)}`,
        hint: "The app cannot reach the identity provider. Check OIDC_ISSUER, its DNS and that the app's container can reach it (firewall, Docker network).",
      });
    }
  } else if (config.OIDC_ISSUER || config.OIDC_CLIENT_SECRET) {
    out.push({
      id: "oidc.discovery",
      group: "sign-in",
      title: "Single sign-on provider",
      status: "warn",
      detail: config.OIDC_ISSUER
        ? "OIDC_ISSUER is set but OIDC_CLIENT_SECRET is empty"
        : "OIDC_CLIENT_SECRET is set but OIDC_ISSUER is empty",
      hint: "Single sign-on needs both OIDC_ISSUER and OIDC_CLIENT_SECRET; it is off until both are set.",
    });
  }

  const local = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(isNotNull(users.passwordHash))
    .get()!.n;
  const admins = db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.disabled, false)))
    .get()!.n;
  const mode = `LOCAL_LOGIN=${config.LOCAL_LOGIN}`;
  if (!config.localLoginEnabled)
    out.push({ id: "local_login", group: "sign-in", title: "Local accounts", status: "ok", detail: `Off (${mode}): single sign-on only` });
  else if (admins === 0)
    out.push({
      id: "local_login",
      group: "sign-in",
      title: "Local accounts",
      status: "warn",
      detail: `On (${mode}) and there is no admin yet`,
      hint: "The first person to open the app creates the admin account. Open it now and create yours.",
    });
  else
    out.push({
      id: "local_login",
      group: "sign-in",
      title: "Local accounts",
      status: "ok",
      detail: `On (${mode}), ${local} local account(s)${config.oidcEnabled ? ", single sign-on also offered" : ""}`,
    });
  return out;
}

export function secretChecks(deps: Deps): Check[] {
  const { config } = deps;
  const out: Check[] = [];
  out.push(
    config.APP_SECRET
      ? { id: "app_secret", group: "app", title: "APP_SECRET", status: "ok", detail: "Set: IMAP/SMTP passwords are stored encrypted" }
      : {
          id: "app_secret",
          group: "app",
          title: "APP_SECRET",
          status: "warn",
          detail: "Not set: domains with an IMAP/SMTP mailbox cannot be added",
          hint: "Only needed for IMAP/SMTP mailbox domains. Generate one with `openssl rand -hex 32`, put it in .env and restart. Never change it afterwards.",
        },
  );
  const s = config.INGEST_SECRET;
  const usesWorker = deps.cf.mode !== "unconfigured";
  const distinct = new Set(s).size;
  if (s === DEFAULT_INGEST_SECRET)
    out.push({
      id: "ingest_secret",
      group: "app",
      title: "INGEST_SECRET",
      status: usesWorker && deps.cf.mode === "live" ? "error" : "warn",
      detail: "Still the development default",
      hint: "Generate one with `openssl rand -hex 32`, set it in .env and as the Worker secret (`npx wrangler secret put INGEST_SECRET`), then restart. Without it anyone could inject mail.",
    });
  else if (s.length < 32 || distinct < 10)
    out.push({
      id: "ingest_secret",
      group: "app",
      title: "INGEST_SECRET",
      status: "warn",
      detail: `Weak: ${s.length} characters, ${distinct} distinct`,
      hint: "Use at least 32 random characters (`openssl rand -hex 32`); update the Worker secret with the same value.",
    });
  else out.push({ id: "ingest_secret", group: "app", title: "INGEST_SECRET", status: "ok", detail: `${s.length} characters` });
  return out;
}
