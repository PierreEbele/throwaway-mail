import { defineConfig } from "@playwright/test";

const PORT = 3299;
const DATA = `./data/e2e-${Date.now()}`;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  retries: 0,
  // Every spec shares one server (and its domains): run them one after the other.
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: [
    {
      command: "pnpm -s tsx scripts/fake-idp.ts",
      url: "http://127.0.0.1:3298/.well-known/openid-configuration",
      reuseExistingServer: false,
      env: { FAKE_IDP_PORT: "3298", OIDC_CLIENT_ID: "throwaway-mail", OIDC_CLIENT_SECRET: "e2e-oidc-secret" },
    },
    {
      command: `node dist/server.js`,
      url: `http://localhost:${PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        CF_MOCK: "1",
        PORT: String(PORT),
        APP_URL: `http://localhost:${PORT}`,
        DATA_DIR: DATA,
        OIDC_ISSUER: "http://127.0.0.1:3298",
        OIDC_CLIENT_SECRET: "e2e-oidc-secret",
        OIDC_ALLOW_INSECURE: "1",
        INGEST_SECRET: "e2e-ingest-secret-0123456789",
        LOG_LEVEL: "warn",
        // Local accounts next to SSO (two-factor-login.spec.ts) and an outgoing relay run by send-from-alias.spec.ts.
        LOCAL_LOGIN: "true",
        LOGIN_RATE_LIMIT_PER_MINUTE: "1000",
        SMTP_RELAY_URL: "smtp://127.0.0.1:3297?tls=none",
      },
    },
  ],
});
