import type { Config } from "./config.js";
import type { Deps } from "./context.js";
import { openDatabase } from "./db/index.js";
import { LiveCloudflareClient, MockCloudflareClient, UnconfiguredCloudflareClient, type CloudflareClient } from "./cloudflare/index.js";
import { OidcService } from "./auth/oidc.js";
import { EventBus } from "./services/events.js";
import { LlmFallbackStrategy } from "./parser/index.js";
import type { Logger } from "./logger.js";
import { dnsResolver } from "./lib/outbound.js";
import { realMailClients } from "./services/mailbox/clients.js";
import { MailboxRunner } from "./services/mailbox/runner.js";

export function buildDeps(config: Config, logger: Logger, overrides: Partial<Deps> = {}): Deps {
  const db = overrides.db ?? openDatabase(config.databasePath, config.MIGRATIONS_DIR);
  const cf: CloudflareClient =
    overrides.cf ??
    (config.CF_MOCK
      ? new MockCloudflareClient()
      : config.CF_API_TOKEN && config.CF_ACCOUNT_ID
        ? new LiveCloudflareClient(config.CF_API_TOKEN, config.CF_ACCOUNT_ID)
        : new UnconfiguredCloudflareClient());
  const deps: Omit<Deps, "mailboxes"> & Partial<Pick<Deps, "mailboxes">> = {
    config,
    db,
    logger,
    cf,
    bus: new EventBus(),
    parserStrategies: config.PARSER_LLM_FALLBACK ? [new LlmFallbackStrategy()] : [],
    now: () => Date.now(),
    oidc: new OidcService(config, logger),
    fetch: (input, init) => fetch(input, init),
    resolve: dnsResolver,
    mail: realMailClients,
    ...overrides,
  };
  deps.mailboxes ??= new MailboxRunner(deps as Deps);
  return deps as Deps;
}
