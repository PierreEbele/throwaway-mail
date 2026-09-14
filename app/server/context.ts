import type { Config } from "./config.js";
import type { DB } from "./db/index.js";
import type { Logger } from "./logger.js";
import type { CloudflareClient } from "./cloudflare/index.js";
import type { EventBus } from "./services/events.js";
import type { ParserStrategy } from "./parser/index.js";
import type { User } from "./db/schema.js";
import type { OidcService } from "./auth/oidc.js";

export interface Deps {
  config: Config;
  db: DB;
  logger: Logger;
  cf: CloudflareClient;
  bus: EventBus;
  parserStrategies: ParserStrategy[];
  now: () => number;
  oidc: OidcService;
}

export interface SessionInfo {
  id: string;
  csrfToken: string;
}

export type AppEnv = {
  Variables: {
    deps: Deps;
    user: User | null;
    session: SessionInfo | null;
    apiKeyId: string | null;
    requestId: string;
  };
};
