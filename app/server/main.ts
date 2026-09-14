import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildDeps } from "./build-deps.js";
import { createApp } from "./app.js";
import { runRetention } from "./services/retention.js";

// Local (non-Docker) runs may keep settings in .env.
try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file */
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const logger = createLogger(config.LOG_LEVEL, { service: "throwaway-mail" });
const deps = buildDeps(config, logger);
const app = createApp(deps);

if (!deps.oidc.enabled) logger.warn("Single sign-on is not configured (OIDC_ISSUER / OIDC_CLIENT_SECRET): nobody can log in");
else logger.info("single sign-on", { issuer: config.OIDC_ISSUER, client_id: config.OIDC_CLIENT_ID, redirect_uri: config.oidcRedirectUri });
if (deps.cf.mode === "mock") logger.warn("Cloudflare MOCK mode (CF_MOCK=1): no real Cloudflare calls are made");
if (deps.cf.mode === "unconfigured") logger.warn("Cloudflare is not configured (CF_API_TOKEN / CF_ACCOUNT_ID): adding domains and destinations will fail");

const retention = () => {
  try {
    runRetention(deps);
  } catch (e) {
    logger.error("retention failed", { err: e as Error });
  }
};
retention();
const retentionTimer = setInterval(retention, 60 * 60 * 1000);
retentionTimer.unref();

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info("listening", { port: info.port, host: config.HOST, app_url: config.APP_URL });
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  clearInterval(retentionTimer);
  const force = setTimeout(() => {
    logger.warn("forced exit after timeout");
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    try {
      deps.db.$client.close();
    } catch {
      /* ignore */
    }
    logger.info("bye");
    process.exit(0);
  });
  // Long-lived SSE / long-poll connections would keep close() waiting.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
