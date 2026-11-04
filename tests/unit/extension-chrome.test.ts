import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "../..");
const firefox = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));

describe("Chrome build of the extension", () => {
  it("derives an MV3 manifest with a service worker, contextMenus and PNG icons", async () => {
    const modPath: string = path.join(root, "scripts/chrome-manifest.mjs");
    const { chromeManifest } = await import(modPath);
    const m = chromeManifest(firefox);
    expect(m.manifest_version).toBe(3);
    expect(m.browser_specific_settings).toBeUndefined();
    expect(m.background).toEqual({ service_worker: "service-worker.js" });
    expect(m.permissions).toContain("contextMenus");
    expect(m.permissions).not.toContain("menus");
    for (const icon of [...Object.values(m.icons), ...Object.values(m.action.default_icon)] as string[]) {
      expect(icon).toMatch(/\.png$/);
      expect(fs.existsSync(path.join(root, "extension", icon))).toBe(true);
    }
    // The service worker loads the same scripts as Firefox's background page.
    const sw = fs.readFileSync(path.join(root, "extension/service-worker.js"), "utf8");
    for (const f of firefox.background.scripts) expect(sw).toContain(`"${f}"`);
  });

  it("compat.js maps chrome.* to browser.* and bridges promise-returning message listeners", async () => {
    let listener: any;
    const chrome = {
      contextMenus: { create() {} },
      storage: { local: {} },
      runtime: { onMessage: { addListener: (f: any) => (listener = f) } },
    };
    const ctx: any = { chrome };
    ctx.globalThis = ctx;
    vm.runInNewContext(fs.readFileSync(path.join(root, "extension/compat.js"), "utf8"), ctx);
    expect(ctx.browser.menus).toBe(chrome.contextMenus);
    expect(ctx.browser.storage).toBe(chrome.storage);
    ctx.browser.runtime.onMessage.addListener(async (msg: any) => ({ echo: msg.n }));
    const reply = await new Promise((resolve) => expect(listener({ n: 7 }, {}, resolve)).toBe(true));
    expect(reply).toEqual({ echo: 7 });
  });

  it("compat.js leaves Firefox's browser namespace alone", () => {
    const browser = { menus: {} };
    const ctx: any = { browser, chrome: {} };
    ctx.globalThis = ctx;
    vm.runInNewContext(fs.readFileSync(path.join(root, "extension/compat.js"), "utf8"), ctx);
    expect(ctx.browser).toBe(browser);
  });
});
