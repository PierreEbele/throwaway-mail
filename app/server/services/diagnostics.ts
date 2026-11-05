import fs from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import { domains, users, type Domain } from "../db/schema.js";
import { checkMailboxDomain } from "./mailbox/check.js";
import { getMailbox } from "./mailbox/settings.js";

/**
 * Setup check: what is configured, what is missing and how to fix it. Used by GET /v1/admin/diagnostics, the
 * admin "Setup check" page and `pnpm doctor`. Every outside call goes through `deps` (fetch, resolveMx, cf, mail),
 * so tests run without network. Never throws: a failing probe becomes an "error" check.
 */

export type CheckStatus = "ok" | "warn" | "error";

export interface Check {
  id: string;
  group: "app" | "sign-in" | "cloudflare" | "domains" | "operations";
  title: string;
  status: CheckStatus;
  /** What was found. */
  detail: string;
  /** What to do about it (warn / error). */
  hint?: string;
}

export interface Diagnostics {
  generated_at: number;
  summary: Record<CheckStatus, number>;
  checks: Check[];
}

const DEFAULT_INGEST_SECRET = "dev-ingest-secret-change-me";
const CLOUDFLARE_MX = /(^|\.)mx\.cloudflare\.net\.?$/i;
const DAY = 86400_000;
/** No mail for this long on a domain is worth a warning. */
const QUIET_DAYS = 14;
/** Newest backup older than this is a warning. */
const BACKUP_MAX_AGE_DAYS = 2;
const TIMEOUT_MS = 8000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ago = (now: number, t: number) => {
  const h = Math.round((now - t) / 3600_000);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

async function appUrlChecks(deps: Deps): Promise<Check[]> {
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

async function signInChecks(deps: Deps): Promise<Check[]> {
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

function secretChecks(deps: Deps): Check[] {
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

async function cloudflareChecks(deps: Deps, cfDomains: Domain[]): Promise<Check[]> {
  const { cf, config } = deps;
  if (cf.mode === "unconfigured") {
    return [
      {
        id: "cloudflare.token",
        group: "cloudflare",
        title: "Cloudflare API token",
        status: cfDomains.length ? "error" : "ok",
        detail: cfDomains.length
          ? `Not configured, but ${cfDomains.length} Cloudflare domain(s) exist`
          : "Not configured: only IMAP/SMTP mailbox domains can be used",
        hint: cfDomains.length
          ? "Set CF_API_TOKEN and CF_ACCOUNT_ID in .env and restart (see Installation → Cloudflare token)."
          : undefined,
      },
    ];
  }
  if (cf.mode === "mock")
    return [
      {
        id: "cloudflare.token",
        group: "cloudflare",
        title: "Cloudflare API token",
        status: "warn",
        detail: "CF_MOCK=1: no real Cloudflare calls are made",
        hint: "Remove CF_MOCK for a real installation.",
      },
    ];

  const out: Check[] = [];
  try {
    const t = await cf.verifyToken();
    out.push(
      t.status === "active"
        ? {
            id: "cloudflare.token",
            group: "cloudflare",
            title: "Cloudflare API token",
            status: "ok",
            detail: `Active${t.expiresOn ? `, expires ${t.expiresOn}` : ""}`,
          }
        : {
            id: "cloudflare.token",
            group: "cloudflare",
            title: "Cloudflare API token",
            status: "error",
            detail: `Token is ${t.status}`,
            hint: "Create a new token (Installation → Cloudflare token) and update CF_API_TOKEN.",
          },
    );
  } catch (e) {
    return [
      {
        id: "cloudflare.token",
        group: "cloudflare",
        title: "Cloudflare API token",
        status: "error",
        detail: msg(e),
        hint: "CF_API_TOKEN is invalid or Cloudflare is unreachable. Check the value (no quotes or spaces) and the server's outbound access. Step by step: docs/cloudflare-tokens.md.",
      },
    ];
  }
  try {
    await cf.findDestinationByEmail("setup-check@invalid.example");
    out.push({
      id: "cloudflare.addresses",
      group: "cloudflare",
      title: "Permission: Email Routing Addresses",
      status: "ok",
      detail: "Destination addresses can be read",
    });
  } catch (e) {
    out.push({
      id: "cloudflare.addresses",
      group: "cloudflare",
      title: "Permission: Email Routing Addresses",
      status: "error",
      detail: msg(e),
      hint: "Give the token Account → Email Routing Addresses → Edit, and check CF_ACCOUNT_ID (Cloudflare dashboard → account home → Account ID).",
    });
  }
  try {
    const exists = await cf.workerExists(config.WORKER_NAME);
    out.push(
      exists === null
        ? {
            id: "cloudflare.worker",
            group: "cloudflare",
            title: "Email Worker deployed",
            status: "ok",
            detail: "Not checked: the token may not read Workers scripts (optional permission)",
          }
        : exists
          ? {
              id: "cloudflare.worker",
              group: "cloudflare",
              title: "Email Worker deployed",
              status: "ok",
              detail: `Worker "${config.WORKER_NAME}" exists`,
            }
          : {
              id: "cloudflare.worker",
              group: "cloudflare",
              title: "Email Worker deployed",
              status: "error",
              detail: `No Worker named "${config.WORKER_NAME}" in this account`,
              hint: "Deploy the Worker (Installation → Email Worker) or set WORKER_NAME to the name in worker/wrangler.toml.",
            },
    );
  } catch (e) {
    out.push({ id: "cloudflare.worker", group: "cloudflare", title: "Email Worker deployed", status: "warn", detail: msg(e) });
  }
  return out;
}

async function cloudflareDomainChecks(deps: Deps, d: Domain): Promise<Check[]> {
  const out: Check[] = [];
  const id = (k: string) => `domain.${k}:${d.name}`;
  // MX records, straight from DNS (what senders see).
  try {
    const mx = await deps.resolveMx(d.name);
    const cfMx = mx.filter((m) => CLOUDFLARE_MX.test(m.exchange));
    if (!mx.length)
      out.push({
        id: id("mx"),
        group: "domains",
        title: `${d.name}: MX records`,
        status: "error",
        detail: "No MX record: nobody can send mail to this domain",
        hint: "Cloudflare dashboard → the zone → Email → Email Routing → Settings → add the records it shows (route1/2/3.mx.cloudflare.net), or press Check on the domain.",
      });
    else if (cfMx.length < mx.length)
      out.push({
        id: id("mx"),
        group: "domains",
        title: `${d.name}: MX records`,
        status: cfMx.length ? "warn" : "error",
        detail: `MX: ${mx.map((m) => `${m.exchange} (${m.priority})`).join(", ")}`,
        hint: "Some MX records do not point to Cloudflare Email Routing (*.mx.cloudflare.net); mail sent to them never reaches the app. Delete the other MX records.",
      });
    else
      out.push({
        id: id("mx"),
        group: "domains",
        title: `${d.name}: MX records`,
        status: "ok",
        detail: mx.map((m) => m.exchange).join(", "),
      });
  } catch (e) {
    out.push({ id: id("mx"), group: "domains", title: `${d.name}: MX records`, status: "warn", detail: `DNS lookup failed: ${msg(e)}` });
  }

  if (deps.cf.mode === "unconfigured") return out;
  if (!d.cfZoneId) {
    out.push({
      id: id("routing"),
      group: "domains",
      title: `${d.name}: Email Routing`,
      status: "error",
      detail: "The domain has no Cloudflare zone recorded",
      hint: "Press Check on the domain in Admin → Domains; if the zone is not found, add the domain to this Cloudflare account first.",
    });
    return out;
  }
  try {
    const enabled = await deps.cf.emailRoutingEnabled(d.cfZoneId);
    out.push(
      enabled
        ? { id: id("routing"), group: "domains", title: `${d.name}: Email Routing`, status: "ok", detail: "Enabled" }
        : {
            id: id("routing"),
            group: "domains",
            title: `${d.name}: Email Routing`,
            status: "error",
            detail: "Email Routing is disabled on the zone",
            hint: "Press Check on the domain (the app enables it), or Cloudflare dashboard → Email → Email Routing → Enable.",
          },
    );
  } catch (e) {
    out.push({
      id: id("routing"),
      group: "domains",
      title: `${d.name}: Email Routing`,
      status: "error",
      detail: msg(e),
      hint: "The token needs Zone → Zone → Read and Zone → Email Routing Rules → Edit on this zone.",
    });
  }
  try {
    const rule = await deps.cf.getCatchAll(d.cfZoneId);
    const worker = rule?.enabled && rule.actions.some((a) => a.type === "worker" && a.value?.includes(deps.config.WORKER_NAME));
    out.push(
      worker
        ? {
            id: id("worker_route"),
            group: "domains",
            title: `${d.name}: catch-all → Worker`,
            status: "ok",
            detail: `Catch-all sends to "${deps.config.WORKER_NAME}"`,
          }
        : {
            id: id("worker_route"),
            group: "domains",
            title: `${d.name}: catch-all → Worker`,
            status: "error",
            detail: rule
              ? `Catch-all is ${rule.enabled ? "enabled" : "disabled"} with ${rule.actions.map((a) => `${a.type}${a.value?.length ? ` ${a.value.join(", ")}` : ""}`).join("; ") || "no action"}`
              : "No catch-all rule",
            hint: `Press Check on the domain (the app sets it), or Cloudflare dashboard → Email Routing → Routing rules → Catch-all → Send to a Worker → ${deps.config.WORKER_NAME}.`,
          },
    );
  } catch (e) {
    out.push({ id: id("worker_route"), group: "domains", title: `${d.name}: catch-all → Worker`, status: "error", detail: msg(e) });
  }
  return out;
}

function lastMailCheck(deps: Deps, d: Domain): Check {
  const now = deps.now();
  const id = `domain.last_mail:${d.name}`;
  const title = `${d.name}: last mail received`;
  if (!d.lastIngestAt)
    return {
      id,
      group: "domains",
      title,
      status: "warn",
      detail: "No mail received yet",
      hint: "Create an address and send it a test mail. If it never arrives, check the other checks of this domain and the Worker logs (`npx wrangler tail`).",
    };
  if (now - d.lastIngestAt > QUIET_DAYS * DAY)
    return {
      id,
      group: "domains",
      title,
      status: "warn",
      detail: `Last mail ${ago(now, d.lastIngestAt)}`,
      hint: "Nothing for a while: normal if the domain is little used, otherwise send a test mail.",
    };
  return { id, group: "domains", title, status: "ok", detail: `Last mail ${ago(now, d.lastIngestAt)}` };
}

async function imapDomainChecks(deps: Deps, d: Domain): Promise<Check[]> {
  const out: Check[] = [];
  const checked = await checkMailboxDomain(deps, d).catch((e: unknown) => ({ ...d, status: "error" as const, statusDetail: msg(e) }));
  out.push(
    checked.status === "active"
      ? {
          id: `domain.mailbox:${d.name}`,
          group: "domains",
          title: `${d.name}: IMAP/SMTP mailbox`,
          status: "ok",
          detail: checked.statusDetail ?? "Connected",
        }
      : {
          id: `domain.mailbox:${d.name}`,
          group: "domains",
          title: `${d.name}: IMAP/SMTP mailbox`,
          status: "error",
          detail: checked.statusDetail ?? "Connection failed",
          hint: "Edit the domain in Admin → Domains: check host, port, TLS, user name and password (an app password if the provider uses 2FA).",
        },
  );
  const m = getMailbox(deps, d.id);
  if (m?.lastPollError)
    out.push({
      id: `domain.poll:${d.name}`,
      group: "domains",
      title: `${d.name}: polling`,
      status: "warn",
      detail: `Last poll failed: ${m.lastPollError}`,
      hint: "The app retries on its own; if this persists, check the mailbox settings.",
    });
  return out;
}

function backupCheck(deps: Deps): Check {
  const dir = path.join(deps.config.DATA_DIR, "backups");
  let newest = 0;
  let count = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^throwaway-.*\.db(\.gz)?$/.test(f)) continue;
      count++;
      newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs);
    }
  } catch {
    /* no backup directory */
  }
  const hint =
    "Schedule scripts/backup.sh daily from the host's cron: `15 3 * * * cd /opt/throwaway-mail && docker compose exec -T app sh scripts/backup.sh`, and copy /data/backups off the server (Operations → Backups).";
  if (!count) return { id: "backups", group: "operations", title: "Backups", status: "warn", detail: `No backup in ${dir}`, hint };
  const now = deps.now();
  if (now - newest > BACKUP_MAX_AGE_DAYS * DAY)
    return {
      id: "backups",
      group: "operations",
      title: "Backups",
      status: "warn",
      detail: `Newest of ${count} backup(s) is from ${ago(now, newest)}`,
      hint,
    };
  return { id: "backups", group: "operations", title: "Backups", status: "ok", detail: `${count} backup(s), newest ${ago(now, newest)}` };
}

/** Which outbound transport is selected (OUTBOUND_TRANSPORT) and whether it can work. */
function outboundCheck(deps: Deps): Check {
  const base = { id: "outbound", group: "app" as const, title: "Outbound mail transport" };
  if (deps.config.OUTBOUND_TRANSPORT === "cloudflare") {
    if (deps.cf.mode === "unconfigured")
      return {
        ...base,
        status: "error",
        detail: "OUTBOUND_TRANSPORT=cloudflare but Cloudflare is not configured",
        hint: "Set CF_API_TOKEN and CF_ACCOUNT_ID.",
      };
    return {
      ...base,
      status: deps.cf.mode === "mock" ? "warn" : "ok",
      detail:
        deps.cf.mode === "mock" ? "Cloudflare Email Sending (mock: nothing is sent)" : "Cloudflare Email Sending (REST API, send_raw)",
      hint: "The token needs Account → Email Sending → Edit, and every alias domain must be onboarded to Email Sending (Cloudflare dashboard → Email Service). See docs/cloudflare-tokens.md.",
    };
  }
  return deps.config.SMTP_RELAY_URL
    ? { ...base, status: "ok", detail: "SMTP relay (SMTP_RELAY_URL)" }
    : {
        ...base,
        status: "ok",
        detail: "SMTP, but SMTP_RELAY_URL is not set: only IMAP domains with their own SMTP server can send",
        hint: "Set SMTP_RELAY_URL or OUTBOUND_TRANSPORT=cloudflare to enable replies and sending on Cloudflare domains.",
      };
}

export async function runDiagnostics(deps: Deps): Promise<Diagnostics> {
  const all = deps.db.select().from(domains).orderBy(domains.name).all();
  const cfDomains = all.filter((d) => d.transport === "cloudflare");
  const imapDomains = all.filter((d) => d.transport === "imap");
  const guard = async (id: string, f: () => Promise<Check[]>): Promise<Check[]> => {
    try {
      return await f();
    } catch (e) {
      return [{ id, group: "app", title: id, status: "error", detail: `Check crashed: ${msg(e)}` }];
    }
  };

  const groups = await Promise.all([
    guard("app_url", () => appUrlChecks(deps)),
    guard("secrets", async () => secretChecks(deps)),
    guard("sign_in", () => signInChecks(deps)),
    guard("outbound", async () => [outboundCheck(deps)]),
    guard("cloudflare", () => cloudflareChecks(deps, cfDomains)),
    ...cfDomains.map((d) => guard(`domain:${d.name}`, async () => [...(await cloudflareDomainChecks(deps, d)), lastMailCheck(deps, d)])),
    ...imapDomains.map((d) => guard(`domain:${d.name}`, async () => [...(await imapDomainChecks(deps, d)), lastMailCheck(deps, d)])),
    guard("backups", async () => [backupCheck(deps)]),
  ]);
  const checks = groups.flat();
  if (!all.length)
    checks.push({
      id: "domains",
      group: "domains",
      title: "Domains",
      status: "warn",
      detail: "No domain yet",
      hint: "Add one in Admin → Domains (Cloudflare Email Routing, or an IMAP/SMTP catch-all mailbox).",
    });
  const order: Check["group"][] = ["app", "sign-in", "cloudflare", "domains", "operations"];
  checks.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.status]++;
  return { generated_at: deps.now(), summary, checks };
}
