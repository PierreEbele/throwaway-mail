import { sql } from "drizzle-orm";
import type { Config } from "./config.js";
import type { Deps } from "./context.js";
import { openDatabase } from "./db/index.js";
import { users } from "./db/schema.js";
import { LiveCloudflareClient, MockCloudflareClient, type CloudflareClient } from "./cloudflare/index.js";
import { EventBus } from "./services/events.js";
import { LlmFallbackStrategy } from "./parser/index.js";
import { randomToken } from "./lib/crypto.js";
import type { Logger } from "./logger.js";

export function buildDeps(config: Config, logger: Logger, overrides: Partial<Deps> = {}): Deps {
  const db = overrides.db ?? openDatabase(config.databasePath, config.MIGRATIONS_DIR);
  const cf: CloudflareClient = overrides.cf ?? (config.CF_MOCK ? new MockCloudflareClient() : new LiveCloudflareClient(config.CF_API_TOKEN, config.CF_ACCOUNT_ID));
  const hasUsers = db.select({ n: sql<number>`count(*)` }).from(users).get()!.n > 0;
  return {
    config,
    db,
    logger,
    cf,
    bus: new EventBus(),
    parserStrategies: config.PARSER_LLM_FALLBACK ? [new LlmFallbackStrategy()] : [],
    now: () => Date.now(),
    setup: { token: hasUsers ? null : (config.SETUP_TOKEN ?? randomToken(18)) },
    ...overrides,
  };
}
