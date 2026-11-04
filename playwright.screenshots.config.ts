import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Regenerates the README screenshots in docs/images: pnpm screenshots
export default defineConfig({
  ...base,
  testDir: "tests/screenshots",
  use: { ...base.use, viewport: { width: 1360, height: 820 }, colorScheme: "dark", deviceScaleFactor: 1 },
});
