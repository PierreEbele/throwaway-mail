import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Regenerates the README screenshots in docs/images: pnpm screenshots
export default defineConfig({
  ...base,
  // The script clicks far faster than a person: lift the per-user API rate limit.
  webServer: [base.webServer].flat().map((w) => (w?.env?.CF_MOCK ? { ...w, env: { ...w.env, RATE_LIMIT_PER_MINUTE: "100000" } } : w!)),
  testDir: "tests/screenshots",
  use: { ...base.use, viewport: { width: 1360, height: 820 }, colorScheme: "dark", deviceScaleFactor: 1 },
});
