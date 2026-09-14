import { defineConfig } from "@playwright/test";

const PORT = 3299;
const DATA = `./data/e2e-${Date.now()}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `node dist/server.js`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CF_MOCK: "1",
      PORT: String(PORT),
      APP_URL: `http://localhost:${PORT}`,
      DATA_DIR: DATA,
      SETUP_TOKEN: "e2e-setup-token-0123456789",
      INGEST_SECRET: "e2e-ingest-secret-0123456789",
      LOG_LEVEL: "warn",
    },
  },
});
