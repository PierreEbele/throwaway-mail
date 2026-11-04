// Derives the Chrome/Chromium MV3 manifest from extension/manifest.json (the Firefox one, the source of truth).
// Usage: node scripts/chrome-manifest.mjs [extension/manifest.json] > manifest.json
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function chromeManifest(firefox) {
  const m = structuredClone(firefox);
  delete m.browser_specific_settings;
  m.minimum_chrome_version = "121";
  m.background = { service_worker: "service-worker.js" };
  m.permissions = m.permissions.map((p) => (p === "menus" ? "contextMenus" : p));
  // Chrome does not render SVG icons.
  const png = (sizes) => Object.fromEntries(sizes.map((s) => [String(s), `icons/throwaway-mail-${s}.png`]));
  m.icons = png([16, 32, 48, 128]);
  if (m.action) m.action.default_icon = png([16, 32, 48]);
  return m;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const src = JSON.parse(fs.readFileSync(process.argv[2] || "extension/manifest.json", "utf8"));
  process.stdout.write(JSON.stringify(chromeManifest(src), null, 2) + "\n");
}
