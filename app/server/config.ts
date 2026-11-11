import path from "node:path";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true" || v === "yes");

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Other public URLs serving the same app (comma-separated), e.g. a second domain. */
  APP_EXTRA_URLS: z.string().default(""),
  DATA_DIR: z.string().default("./data"),
  DATABASE_PATH: z.string().optional(),
  MIGRATIONS_DIR: z.string().default("./app/server/db/migrations"),
  WEB_DIST_DIR: z.string().default("./dist/web"),
  INGEST_SECRET: z.string().min(16, "INGEST_SECRET must be at least 16 characters").default("dev-ingest-secret-change-me"),
  MAX_INGEST_BYTES: z.coerce
    .number()
    .int()
    .default(25 * 1024 * 1024),
  CF_MOCK: bool,
  CF_API_TOKEN: z.string().default(""),
  CF_ACCOUNT_ID: z.string().default(""),
  WORKER_NAME: z.string().default("throwaway-mail-ingest"),
  RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  /** Enables GET /metrics (Prometheus) for clients sending Authorization: Bearer <METRICS_TOKEN>. */
  METRICS_TOKEN: z.string().min(16).optional(),
  COOKIE_SECURE: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(240),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(10),
  /** Failed sign-in / two-factor attempts per account before it is locked out for LOGIN_LOCKOUT_MINUTES. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
  SESSION_TTL_DAYS: z.coerce.number().int().default(14),
  PARSER_LLM_FALLBACK: bool,
  // Single sign-on (OpenID Connect). Optional when local accounts are enabled (LOCAL_LOGIN).
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().default("throwaway-mail"),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default("openid profile email groups"),
  /** Members of this IdP group become admins (synced at every login). */
  OIDC_ADMIN_GROUP: z.string().default("admins"),
  /** Optional comma-separated groups allowed to log in (empty = anyone the IdP lets through). */
  OIDC_ALLOWED_GROUPS: z.string().default(""),
  OIDC_PROVIDER_NAME: z.string().default("Authelia"),
  /** Allow an http:// issuer (local development / tests only). */
  OIDC_ALLOW_INSECURE: bool,
  /**
   * Local accounts (e-mail + password). "auto" (default) enables them only when single sign-on is not configured;
   * "true" offers both; "false" disables them.
   */
  LOCAL_LOGIN: z.enum(["auto", "true", "false"]).default("auto"),
  /** Web Push (VAPID) key pair, base64url. Generated and stored in the database when unset. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** VAPID contact (mailto: or https: URL) sent to push services; default: the origin of APP_URL. */
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, "VAPID_SUBJECT must start with mailto: or https://")
    .optional(),
  /** Key for secrets stored in the database (IMAP/SMTP passwords). 32+ characters; required to add IMAP domains. */
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters").optional(),
  // Backups made by the server itself (0 = off; scripts/backup.sh from host cron keeps working either way).
  BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).default(0),
  BACKUP_DIR: z.string().optional(),
  BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).default(14),
  /** Off-site copies on S3-compatible storage (R2, Backblaze B2, MinIO…), encrypted with BACKUP_PASSPHRASE. */
  BACKUP_S3_ENDPOINT: z.string().url().optional(),
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_REGION: z.string().default("auto"),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_S3_PREFIX: z.string().default("throwaway-mail/"),
  /** Number of off-site backups kept (older ones are deleted after each upload). */
  BACKUP_S3_KEEP: z.coerce.number().int().min(1).default(30),
  BACKUP_PASSPHRASE: z.string().min(12, "BACKUP_PASSPHRASE must be at least 12 characters").optional(),
  /** End-to-end probe: SMTP relay used to send the test mail (smtp://user:pass@host:587 or smtps://…:465). */
  PROBE_SMTP_URL: z.string().url().optional(),
  PROBE_FROM: z.string().optional(),
  /**
   * Outbound SMTP server for reverse-alias replies on Cloudflare domains (IMAP domains use their own SMTP server):
   * smtps://user:pass@host:465 (implicit TLS), smtp://user:pass@host:587 (STARTTLS), smtp://host:25?tls=none.
   */
  SMTP_RELAY_URL: z
    .string()
    .regex(/^smtps?:\/\//, "SMTP_RELAY_URL must start with smtp:// or smtps://")
    .optional(),
  /**
   * How mail leaves the app when no domain mailbox SMTP server applies (Cloudflare domains, IMAP domains without
   * SMTP): "smtp" (SMTP_RELAY_URL, default) or "cloudflare" (Cloudflare Email Sending REST API, with CF_API_TOKEN).
   */
  OUTBOUND_TRANSPORT: z.enum(["smtp", "cloudflare"]).default("smtp"),
  /** Envelope sender for mail sent through SMTP_RELAY_URL (default: the alias itself). */
  SMTP_RELAY_FROM: z.string().email().optional(),
  /**
   * SMTP submission server (send new mail from an alias with any mail client). Off unless set: 587 (STARTTLS) or 465
   * (SUBMISSION_TLS=implicit). Users sign in with their e-mail and an SMTP password created in the web UI.
   */
  SUBMISSION_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  SUBMISSION_HOST: z.string().default("0.0.0.0"),
  /** "starttls" (default, port 587) or "implicit" (TLS from the first byte, port 465). */
  SUBMISSION_TLS: z.enum(["starttls", "implicit"]).default("starttls"),
  /** PEM certificate chain and private key paths (e.g. the reverse proxy's Let's Encrypt files). */
  SUBMISSION_TLS_CERT: z.string().optional(),
  SUBMISSION_TLS_KEY: z.string().optional(),
  /** Name announced in the SMTP greeting (default: the host of APP_URL). */
  SUBMISSION_HOSTNAME: z.string().optional(),
  /** Development only: accept AUTH over a plain connection when no certificate is configured. */
  SUBMISSION_ALLOW_INSECURE: bool,
  /** Mails a user may send per hour (SMTP submission, compose dialog and API together). */
  SEND_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(30),
  /** Recipients (To + Cc + Bcc) per sent mail. */
  SEND_MAX_RECIPIENTS: z.coerce.number().int().min(1).default(20),
  /**
   * Public demo: writes that matter are refused (domains, destinations, users, keys, notifications), nothing is
   * forwarded, visitors enter with one click, and the data is reset from a seed every DEMO_RESET_MINUTES.
   */
  DEMO_MODE: bool,
  DEMO_RESET_MINUTES: z.coerce.number().int().min(5).default(60),
  /** Directory with the .eml files of the demo seed (the repository's tests/fixtures; /app/demo-mail in the image). */
  DEMO_MAIL_DIR: z.string().default("./tests/fixtures"),
  /** Replies must pass SPF, DKIM or DMARC at the receiving server (Authentication-Results). Default true. */
  REPLY_REQUIRE_AUTH: z
    .string()
    .optional()
    .transform((v) => !(v === "0" || v === "false" || v === "no")),
  /** Comma-separated authserv-ids whose Authentication-Results headers are read (case-insensitive). Empty: all. */
  TRUSTED_AUTHSERV_IDS: z.string().default(""),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // Docker Compose passes unset optional variables as "": treat them as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const parsed = result.data;
  const isProd = parsed.NODE_ENV === "production";
  // The Worker signs with INGEST_SECRET; without Cloudflare (IMAP domains only) /ingest refuses everything instead.
  if (isProd && parsed.CF_API_TOKEN && parsed.INGEST_SECRET === "dev-ingest-secret-change-me") {
    throw new Error("INGEST_SECRET must be set in production when Cloudflare is configured");
  }
  const oidcEnabled = !!(parsed.OIDC_ISSUER && parsed.OIDC_CLIENT_SECRET);
  const localLoginEnabled = parsed.LOCAL_LOGIN === "true" || (parsed.LOCAL_LOGIN === "auto" && !oidcEnabled);
  if (!oidcEnabled && !localLoginEnabled) {
    throw new Error(
      "No way to log in: LOCAL_LOGIN=false requires single sign-on (OIDC_ISSUER and OIDC_CLIENT_SECRET). Set them, or set LOCAL_LOGIN=auto|true",
    );
  }
  const s3 = [parsed.BACKUP_S3_ENDPOINT, parsed.BACKUP_S3_BUCKET, parsed.BACKUP_S3_ACCESS_KEY_ID, parsed.BACKUP_S3_SECRET_ACCESS_KEY];
  const offsiteBackup = s3.every(Boolean);
  if (s3.some(Boolean) && !offsiteBackup) {
    throw new Error(
      "Off-site backups need all of BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY",
    );
  }
  if (offsiteBackup && !parsed.BACKUP_PASSPHRASE)
    throw new Error("Off-site backups need BACKUP_PASSPHRASE (they are encrypted before upload)");
  if (!!parsed.SUBMISSION_TLS_CERT !== !!parsed.SUBMISSION_TLS_KEY)
    throw new Error("SMTP submission needs both SUBMISSION_TLS_CERT and SUBMISSION_TLS_KEY");
  if (parsed.SUBMISSION_PORT > 0 && !parsed.SUBMISSION_TLS_CERT) {
    if (parsed.SUBMISSION_TLS === "implicit") throw new Error("SUBMISSION_TLS=implicit needs SUBMISSION_TLS_CERT and SUBMISSION_TLS_KEY");
    if (!parsed.SUBMISSION_ALLOW_INSECURE)
      throw new Error(
        "SMTP submission refuses passwords over plain connections: set SUBMISSION_TLS_CERT and SUBMISSION_TLS_KEY (or SUBMISSION_ALLOW_INSECURE=true for local development only)",
      );
  }
  if (parsed.OUTBOUND_TRANSPORT === "cloudflare" && !parsed.CF_MOCK && !(parsed.CF_API_TOKEN && parsed.CF_ACCOUNT_ID))
    throw new Error("OUTBOUND_TRANSPORT=cloudflare needs CF_API_TOKEN and CF_ACCOUNT_ID (or CF_MOCK=1)");
  const cookieSecure =
    parsed.COOKIE_SECURE !== undefined
      ? parsed.COOKIE_SECURE === "1" || parsed.COOKIE_SECURE === "true"
      : parsed.APP_URL.startsWith("https://");
  return {
    ...parsed,
    isProd,
    oidcEnabled,
    localLoginEnabled,
    cookieSecure,
    /** /ingest only accepts mail signed with a real secret in production. */
    ingestEnabled: !isProd || !!parsed.CF_MOCK || parsed.INGEST_SECRET !== "dev-ingest-secret-change-me",
    databasePath: parsed.DATABASE_PATH ?? path.join(parsed.DATA_DIR, "throwaway.db"),
    backupDir: parsed.BACKUP_DIR ?? path.join(parsed.DATA_DIR, "backups"),
    offsiteBackup,
    oidcAllowedGroups: parsed.OIDC_ALLOWED_GROUPS.split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    /** Lower-case authserv-ids from TRUSTED_AUTHSERV_IDS; empty: every Authentication-Results header is read. */
    trustedAuthservIds: parsed.TRUSTED_AUTHSERV_IDS.split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    oidcRedirectUri: `${parsed.APP_URL.replace(/\/$/, "")}/v1/auth/oidc/callback`,
    /** Every public origin of the app; the first one is the primary (APP_URL). */
    appOrigins: [parsed.APP_URL, ...parsed.APP_EXTRA_URLS.split(",")]
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => new URL(u).origin),
  };
}
