import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { addDomain, ingest, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";

// Runs the Firefox extension's API client (extension/throwaway.js) against the real app.
function loadClient(t: ReturnType<typeof makeTestApp>, store: Record<string, unknown>) {
  const sandbox: Record<string, unknown> = {
    URL,
    URLSearchParams,
    browser: {
      storage: { local: { get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])) } },
    },
    fetch: (url: string, init: RequestInit) => {
      const u = new URL(url);
      expect(u.origin).toBe("https://mail.example.test");
      return t.app.request(u.pathname + u.search, init);
    },
  };
  const src = fs.readFileSync(path.join(__dirname, "../../extension/throwaway.js"), "utf8");
  vm.runInNewContext(`${src}\nglobalThis.Throwaway = Throwaway;`, sandbox);
  return sandbox.Throwaway as any;
}

describe("Firefox extension client", () => {
  it("creates a per-site address with an API key and retrieves the code", async () => {
    const t = makeTestApp();
    const admin = await setupAdmin(t);
    await addDomain(admin, "mail.example.test");
    const key = await admin.post("/v1/keys", { name: "extension" });
    expect(key.status).toBe(201);

    const tm = loadClient(t, { tmServer: "https://mail.example.test", tmApiKey: key.json.key });
    expect(await tm.enabled()).toBe(true);

    const alias = await tm.createAddress("https://shop.example.org/register?x=1", "Ada Lovelace");
    expect(alias.email).toMatch(/@mail\.example\.test$/);
    expect(alias.host).toBe("shop.example.org");
    const stored = (await admin.get(`/v1/addresses/${alias.id}`)).json.address;
    expect(stored.site_name).toBe("shop.example.org");
    expect(stored.label).toBe("Throwaway Mail · Ada Lovelace");

    expect(await tm.waitForCode(alias.id, alias.createdAt, 0)).toBeNull();
    const r = await ingest(t, alias.email, simpleEml({ subject: "Votre code", text: "Votre code de vérification est 482913." }));
    expect(r.status).toBeLessThan(300);
    const found = await tm.waitForCode(alias.id, alias.createdAt, 0);
    expect(found.code).toBe("482913");
    // Asking again after that message waits for the next one.
    expect(await tm.waitForCode(alias.id, found.message_id, 0)).toBeNull();
  });

  it("reports an invalid key and refuses plain-http servers", async () => {
    const t = makeTestApp();
    const tm = loadClient(t, { tmServer: "https://mail.example.test", tmApiKey: "tm_bad" });
    await expect(tm.createAddress("https://a.example/", "x")).rejects.toMatchObject({ status: 401 });
    expect(() => tm.normalizeServer("http://mail.example.test")).toThrow(/HTTPS/);
    expect(tm.normalizeServer("https://mail.example.test/app/")).toBe("https://mail.example.test");
  });
});
