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
  DATA_DIR: z.string().default("./data"),
  DATABASE_PATH: z.string().optional(),
  MIGRATIONS_DIR: z.string().default("./app/server/db/migrations"),
  WEB_DIST_DIR: z.string().default("./dist/web"),
  INGEST_SECRET: z.string().min(16, "INGEST_SECRET must be at least 16 characters").default("dev-ingest-secret-change-me"),
  MAX_INGEST_BYTES: z.coerce.number().int().default(25 * 1024 * 1024),
  CF_MOCK: bool,
  CF_API_TOKEN: z.string().default(""),
  CF_ACCOUNT_ID: z.string().default(""),
  WORKER_NAME: z.string().default("throwaway-mail-ingest"),
  RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  COOKIE_SECURE: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(240),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(10),
  SESSION_TTL_DAYS: z.coerce.number().int().default(14),
  PARSER_LLM_FALLBACK: bool,
  // Single sign-on (OpenID Connect) — the only way to log in.
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
  if (isProd && !parsed.CF_MOCK && parsed.INGEST_SECRET === "dev-ingest-secret-change-me") {
    throw new Error("INGEST_SECRET must be set in production (only CF_MOCK=1 may run with the default)");
  }
  if (isProd && (!parsed.OIDC_ISSUER || !parsed.OIDC_CLIENT_SECRET)) {
    throw new Error("OIDC_ISSUER and OIDC_CLIENT_SECRET are required: single sign-on is the only way to log in");
  }
  const cookieSecure =
    parsed.COOKIE_SECURE !== undefined
      ? parsed.COOKIE_SECURE === "1" || parsed.COOKIE_SECURE === "true"
      : parsed.APP_URL.startsWith("https://");
  return {
    ...parsed,
    isProd,
    cookieSecure,
    databasePath: parsed.DATABASE_PATH ?? path.join(parsed.DATA_DIR, "throwaway.db"),
    oidcAllowedGroups: parsed.OIDC_ALLOWED_GROUPS.split(",").map((g) => g.trim()).filter(Boolean),
    oidcRedirectUri: `${parsed.APP_URL.replace(/\/$/, "")}/v1/auth/oidc/callback`,
  };
}
