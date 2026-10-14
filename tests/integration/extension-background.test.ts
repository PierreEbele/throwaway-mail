import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { addDomain, makeTestApp, setupAdmin } from "../helpers.js";

// Exécute le script de fond de l'extension (generator + throwaway + background) avec un faux `browser`.
function loadBackground(t: ReturnType<typeof makeTestApp>, store: Record<string, any>) {
  let onMessage: any;
  const filled: any[] = [];
  const browser = {
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries([keys].flat().filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
        set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
        remove: async (keys: string[]) => keys.forEach((k) => delete store[k]),
      },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener: (f: any) => (onMessage = f) }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    permissions: { contains: async () => true },
    scripting: {
      executeScript: async (o: any) => {
        if (o.args) filled.push(o.args);
        return [{ result: { filled: 3 } }];
      },
    },
  };
  const sandbox: Record<string, unknown> = {
    URL, URLSearchParams, crypto, structuredClone, browser, console,
    fetch: (url: string, init: RequestInit) => {
      const u = new URL(url);
      return t.app.request(u.pathname + u.search, init);
    },
  };
  vm.createContext(sandbox);
  for (const f of ["generator.js", "throwaway.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../../extension", f), "utf8").replace(/^const (\w+) =/m, "globalThis.$1 ="), sandbox);
  }
  const send = (msg: unknown, url = "https://shop.example.org/register") => onMessage(msg, { tab: { id: 1, url } });
  return { send, filled };
}

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const key = (await admin.post("/v1/keys", { name: "fable" })).json.key;
  const store: Record<string, any> = { tmServer: "https://mail.example.test", tmApiKey: key };
  return { t, admin, store, ...loadBackground(t, store) };
}

describe("extension background", () => {
  it("Bitwarden mode leaves email and password, then adopts the alias Bitwarden filled in", async () => {
    const { admin, store, send, filled } = await setup();
    store.bitwardenMode = true;
    const r = await send({ type: "fill-new" });
    expect(r.bitwarden).toBe(true);
    const fields: string[] = filled[0][1].fields;
    expect(fields).not.toContain("email");
    expect(fields).not.toContain("password");
    expect(fields).toContain("firstName");
    expect((await admin.get("/v1/addresses")).json.addresses).toHaveLength(0); // aucune adresse créée par Fable

    // Bitwarden crée l'alias (API compatible) et le remplit dans la page
    const alias = (await admin.post("/v1/addresses", { site_name: "shop.example.org" })).json.address;
    expect(await send({ type: "adopt-email", email: "someone@gmail.com" })).toEqual({ ok: false });
    expect(await send({ type: "adopt-email", email: alias.email.toUpperCase() })).toEqual({ ok: true, email: alias.email });
    expect(store.tmPending["shop.example.org"].id).toBe(alias.id);
  });

  it("normal mode still creates the alias itself", async () => {
    const { admin, send, filled } = await setup();
    const r = await send({ type: "fill-new" });
    expect(r.email).toMatch(/@mail\.example\.test$/);
    expect(filled[0][1].fields).toContain("email");
    expect((await admin.get("/v1/addresses")).json.addresses).toHaveLength(1);
  });

  it("expires the identity after the configured time", async () => {
    const { store, send } = await setup();
    store.profile = { firstName: "A", createdAt: Date.now() - 2 * 3600_000 };
    store.identityTtlHours = 24;
    await send({ type: "purge" });
    expect(store.profile).toBeDefined();
    store.identityTtlHours = 1;
    await send({ type: "purge" });
    expect(store.profile).toBeUndefined();
    store.profile = { firstName: "B", createdAt: 0 };
    store.identityTtlHours = 0; // jamais
    await send({ type: "purge" });
    expect(store.profile).toBeDefined();
    store.profile = { firstName: "C" }; // ancienne identité sans date : datée, pas effacée
    store.identityTtlHours = 1;
    await send({ type: "purge" });
    expect(store.profile.createdAt).toBeGreaterThan(0);
  });
});
