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
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  const isProd = parsed.NODE_ENV === "production";
  if (isProd && parsed.INGEST_SECRET === "dev-ingest-secret-change-me") {
    throw new Error("INGEST_SECRET must be set in production");
  }
  if (!parsed.CF_MOCK && isProd && (!parsed.CF_API_TOKEN || !parsed.CF_ACCOUNT_ID)) {
    throw new Error("CF_API_TOKEN and CF_ACCOUNT_ID are required unless CF_MOCK=1");
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
  };
}
