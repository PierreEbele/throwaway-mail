import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { swaggerUI } from "@hono/swagger-ui";
import { sql } from "drizzle-orm";
import type { AppEnv, Deps } from "./context.js";
import { HttpError } from "./lib/errors.js";
import { ApiRouter, clientIp } from "./lib/http.js";
import { randomString } from "./lib/crypto.js";
import { authenticate, callerKey, csrf, rateLimit } from "./auth/middleware.js";
import { RateLimiter } from "./auth/ratelimit.js";
import { registerIngest } from "./routes/ingest.js";
import { registerAuth } from "./routes/auth.js";
import { registerAdmin } from "./routes/admin.js";
import { registerAddresses } from "./routes/addresses.js";
import { registerDomains } from "./routes/domains.js";
import { registerDestinations } from "./routes/destinations.js";
import { registerKeys } from "./routes/keys.js";
import { registerEvents } from "./routes/events.js";
import { registerReview } from "./routes/review.js";
import { registerCompat } from "./routes/compat.js";

const APP_CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // 'unsafe-inline' styles are needed for e-mail HTML shown in the sandboxed srcdoc iframe (which inherits this policy).
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  frameSrc: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  baseUri: ["'none'"],
  objectSrc: ["'none'"],
};

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const log = deps.logger.child({ component: "http" });

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("requestId", randomString(12));
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    const p = c.req.path;
    if (p !== "/healthz" && !p.startsWith("/assets/")) {
      log.info("request", { id: c.get("requestId"), method: c.req.method, path: p, status: c.res.status, ms, ip: clientIp(c) });
    }
  });

  app.use("/docs", secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"], styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"], imgSrc: ["'self'", "data:", "https://cdn.jsdelivr.net"], connectSrc: ["'self'"] } }));
  app.use("*", async (c, next) => {
    if (c.req.path === "/docs") return next();
    return secureHeaders({ contentSecurityPolicy: APP_CSP, referrerPolicy: "no-referrer", crossOriginEmbedderPolicy: false })(c, next);
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status);
    }
    log.error("unhandled error", { err, path: c.req.path, id: c.get("requestId") });
    return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

  app.get("/healthz", (c) => {
    try {
      deps.db.get(sql`select 1`);
      return c.json({ status: "ok", cloudflare: deps.cf.mode });
    } catch {
      return c.json({ status: "error" }, 503);
    }
  });

  registerIngest(app);

  // API: auth → CSRF → rate limit
  const limiter = new RateLimiter(deps.config.RATE_LIMIT_PER_MINUTE);
  app.use("/v1/*", authenticate, csrf, rateLimit(limiter, callerKey));
  const api = new ApiRouter(app);
  registerAuth(api);
  registerAddresses(api);
  registerDomains(api);
  registerDestinations(api);
  registerKeys(api);
  registerEvents(api);
  registerReview(api);
  registerAdmin(api);
  app.all("/v1/*", (c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

  // SimpleLogin / addy.io compatible endpoints for the Bitwarden username generator
  registerCompat(app, limiter);

  const doc = api.openapi(
    { title: "Throwaway Mail API", version: "1.0.0", description: "Disposable addresses, inbound mail, parsed verification codes. Authenticate with `Authorization: Bearer tm_…`." },
    deps.config.APP_URL,
  );
  app.get("/openapi.json", (c) => c.json(doc));
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  // Static web UI (single-page app)
  const webDir = path.resolve(deps.config.WEB_DIST_DIR);
  const indexFile = path.join(webDir, "index.html");
  if (fs.existsSync(indexFile)) {
    const indexHtml = fs.readFileSync(indexFile, "utf8");
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.status === 200) c.header("cache-control", "public, max-age=31536000, immutable");
    });
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDir) || "." }));
    app.get("*", (c) => {
      c.header("cache-control", "no-cache");
      return c.html(indexHtml);
    });
  } else {
    app.get("/", (c) => c.text("Throwaway Mail API is running. Web UI not built (run `pnpm build:web`). API docs: /docs"));
  }

  return app;
}
