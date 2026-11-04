import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildDeps } from "./build-deps.js";
import { createApp } from "./app.js";
import { runRetention } from "./services/retention.js";
import { pruneIconCache } from "./services/icons.js";
import { pauseExpired, runExpiryReminders } from "./services/reminders.js";
import { metrics } from "./services/metrics.js";
import { backfillAuthResults } from "./services/maintenance.js";
import { scheduledBackup } from "./services/backup/index.js";
import { probeTick } from "./services/probe.js";
import { startSubmission } from "./services/submission.js";

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

if (config.localLoginEnabled) logger.info("local accounts enabled (e-mail + password)");
if (deps.oidc.enabled)
  logger.info("single sign-on", {
    issuer: config.OIDC_ISSUER,
    client_id: config.OIDC_CLIENT_ID,
    redirect_uris: config.appOrigins.map((o) => `${o}/v1/auth/oidc/callback`),
  });
if (deps.cf.mode === "mock") logger.warn("Cloudflare MOCK mode (CF_MOCK=1): no real Cloudflare calls are made");
if (deps.cf.mode === "unconfigured")
  logger.info("Cloudflare is not configured (CF_API_TOKEN / CF_ACCOUNT_ID): only IMAP/SMTP mailbox domains can be used");
if (!config.APP_SECRET) logger.info("APP_SECRET is not set: IMAP/SMTP mailbox domains cannot be added");

try {
  backfillAuthResults(deps);
} catch (e) {
  logger.error("auth results backfill failed", { err: e as Error });
}

const retention = () => {
  try {
    const n = runRetention(deps);
    metrics.job("retention", true, `${n} message(s) deleted`);
    void pruneIconCache(deps).catch((e) => logger.warn("icon cache pruning failed", { err: e as Error }));
  } catch (e) {
    metrics.job("retention", false, (e as Error).message);
    logger.error("retention failed", { err: e as Error });
  }
};
const reminders = () => {
  try {
    const n = runExpiryReminders(deps);
    const paused = pauseExpired(deps);
    metrics.job("expiry_reminders", true, `${n} reminder(s) sent, ${paused} expired address(es) paused`);
  } catch (e) {
    metrics.job("expiry_reminders", false, (e as Error).message);
    logger.error("expiry reminders failed", { err: e as Error });
  }
};
retention();
reminders();
deps.mailboxes.start();
const stopSubmission = startSubmission(deps);
const retentionTimer = setInterval(retention, 60 * 60 * 1000);
retentionTimer.unref();
const reminderTimer = setInterval(reminders, 10 * 60 * 1000);
reminderTimer.unref();

let backupTimer: NodeJS.Timeout | null = null;
if (config.BACKUP_INTERVAL_HOURS > 0) {
  let running = false;
  const backup = () => {
    if (running) return;
    running = true;
    scheduledBackup(deps)
      .catch((e) => logger.error("backup job crashed", { err: e as Error }))
      .finally(() => (running = false));
  };
  backupTimer = setInterval(backup, config.BACKUP_INTERVAL_HOURS * 3600_000);
  backupTimer.unref();
  logger.info("scheduled backups", { every_hours: config.BACKUP_INTERVAL_HOURS, offsite: config.offsiteBackup });
}
let probing = false;
const probeTimer = setInterval(() => {
  if (probing) return;
  probing = true;
  probeTick(deps)
    .catch((e) => logger.error("probe job crashed", { err: e as Error }))
    .finally(() => (probing = false));
}, 60_000);
probeTimer.unref();

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info("listening", { port: info.port, host: config.HOST, app_url: config.APP_URL });
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  clearInterval(retentionTimer);
  clearInterval(reminderTimer);
  clearInterval(probeTimer);
  if (backupTimer) clearInterval(backupTimer);
  deps.mailboxes.stop();
  void stopSubmission?.();
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
