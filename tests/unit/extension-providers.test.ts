import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Runs the extension's alias providers (extension/providers/*.js) against a fake `fetch`: no network.
const root = path.join(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
const files: string[] = manifest.background.scripts.filter((f: string) => f === "throwaway.js" || f.startsWith("providers/"));

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Route = (call: Call) => { status?: number; json?: unknown };

function load(store: Record<string, any> = {}, route: Route = () => ({ status: 404 })) {
  const calls: Call[] = [];
  const sandbox: Record<string, unknown> = {
    URL,
    URLSearchParams,
    crypto,
    btoa,
    browser: {
      storage: {
        local: {
          get: async (keys: string | string[]) =>
            Object.fromEntries(
              [keys]
                .flat()
                .filter((k) => k in store)
                .map((k) => [k, structuredClone(store[k])]),
            ),
          set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
        },
      },
    },
    fetch: async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url,
        method: init.method || "GET",
        headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) || {}).map(([k, v]) => [k.toLowerCase(), v])),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const r = route(call);
      return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status || 200 });
    },
  };
  vm.createContext(sandbox);
  for (const f of files)
    vm.runInContext(fs.readFileSync(path.join(root, "extension", f), "utf8").replace(/^const (\w+) =/m, "globalThis.$1 ="), sandbox);
  return { P: sandbox.AliasProviders as any, calls, store };
}

const ctx = { site: "shop.example.org", url: "https://shop.example.org", note: "Throwaway Mail extension · shop.example.org" };

describe("alias providers", () => {
  it("registers every adapter, only Throwaway Mail fetches codes, and all scripts are loaded everywhere", () => {
    const { P } = load();
    expect(P.list().map((p: any) => p.id)).toEqual([
      "none",
      "throwaway",
      "simplelogin",
      "addy",
      "firefox-relay",
      "fastmail",
      "forward-email",
      "duckduckgo",
    ]);
    expect(
      P.list()
        .filter((p: any) => p.codes)
        .map((p: any) => p.id),
    ).toEqual(["throwaway"]);
    const sw = fs.readFileSync(path.join(root, "extension/service-worker.js"), "utf8");
    for (const page of ["popup.html", "options.html"]) {
      const html = fs.readFileSync(path.join(root, "extension", page), "utf8");
      for (const f of files) expect(html, `${page} loads ${f}`).toContain(`src="${f}"`);
    }
    for (const f of files) expect(sw).toContain(`"${f}"`);
  });

  it("defaults to no service, and keeps Throwaway Mail for installs that already had it", async () => {
    expect(await load().P.selectedId()).toBe("none");
    expect(await load().P.active()).toBeNull(); // nothing set up: @example.com addresses
    expect(await load({ tmServer: "https://mail.example.test", tmApiKey: "tm_x" }).P.selectedId()).toBe("throwaway");
    expect(await load({ tmServer: "https://mail.example.test", tmApiKey: "tm_x", aliasProvider: "addy" }).P.selectedId()).toBe("addy");
  });

  it("no service: catch-all pattern and plus-addressing, without any request", async () => {
    const { P, calls } = load({
      aliasProvider: "none",
      providerSettings: { none: { mode: "catchall", domain: "Catch.Example.NET", pattern: "{site}-{random}" } },
    });
    const a = await P.createAlias("https://www.netflix.com/signup");
    expect(a.email).toMatch(/^netflix-[a-z0-9]{6}@catch\.example\.net$/);
    expect(a).toMatchObject({ host: "www.netflix.com", provider: "none" });
    expect(P.siteLabel("shop.bbc.co.uk")).toBe("bbc");
    expect(P.siteLabel("localhost")).toBe("localhost");
    const local = P.get("none");
    expect((await local.createAlias({ mode: "plus", address: "Me@Gmail.com" }, ctx)).email).toBe("me+example@gmail.com");
    expect(local.configured({ mode: "plus", address: "not-an-address" })).toBe(false);
    expect(local.configured({ mode: "catchall", domain: "nodot" })).toBe(false);
    expect(await local.testConnection({ mode: "catchall", domain: "example.net" })).toMatch(/@example\.net$/);
    expect(P.originPattern(local, {})).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("SimpleLogin: random alias with the hostname, Authentication header, self-hosted URL", async () => {
    const { P, calls } = load({}, (c) =>
      c.url.includes("/api/alias/random/new")
        ? { status: 201, json: { alias: "random.word123@simplelogin.com", id: 7 } }
        : { json: { name: "Ada", email: "ada@example.org" } },
    );
    const sl = P.get("simplelogin");
    const cfg = { baseUrl: "https://sl.example.org/", apiKey: "k1" };
    expect(await sl.createAlias(cfg, ctx)).toEqual({ email: "random.word123@simplelogin.com", id: 7 });
    expect(calls[0]).toMatchObject({
      url: "https://sl.example.org/api/alias/random/new?hostname=shop.example.org",
      method: "POST",
      headers: { authentication: "k1" },
      body: { note: ctx.note },
    });
    expect(await sl.testConnection(cfg)).toMatch(/Ada/);
    expect(calls[1].url).toBe("https://sl.example.org/api/user_info");
    expect(P.originPattern(sl, cfg)).toBe("https://sl.example.org/*");
    expect(P.originPattern(sl, {})).toBe("https://app.simplelogin.io/*");
  });

  it("addy.io: alias on the chosen domain with a Bearer token", async () => {
    const { P, calls } = load({}, (c) =>
      c.method === "POST"
        ? { status: 201, json: { data: { id: "u-1", email: "x1y2@anonaddy.me" } } }
        : { json: { data: { username: "ada" } } },
    );
    const addy = P.get("addy");
    const cfg = { apiKey: "t", domain: "anonaddy.me" };
    expect(await addy.createAlias(cfg, ctx)).toEqual({ email: "x1y2@anonaddy.me", id: "u-1" });
    expect(calls[0]).toMatchObject({
      url: "https://app.addy.io/api/v1/aliases",
      headers: { authorization: "Bearer t", "x-requested-with": "XMLHttpRequest" },
      body: { domain: "anonaddy.me", description: ctx.note },
    });
    expect(await addy.testConnection(cfg)).toMatch(/ada/);
    expect(calls[1].url).toBe("https://app.addy.io/api/v1/account-details");
    expect(addy.configured({ apiKey: "t", domain: "" })).toBe(false);
  });

  it("Firefox Relay: Token auth, generated_for the site", async () => {
    const { P, calls } = load({}, (c) =>
      c.method === "POST" ? { status: 201, json: { id: 3, full_address: "abc123@mozmail.com" } } : { json: [{ has_premium: false }] },
    );
    const relay = P.get("firefox-relay");
    expect(await relay.createAlias({ apiKey: "r" }, ctx)).toEqual({ email: "abc123@mozmail.com", id: 3 });
    expect(calls[0]).toMatchObject({
      url: "https://relay.firefox.com/api/v1/relayaddresses/",
      headers: { authorization: "Token r" },
      body: { enabled: true, generated_for: "https://shop.example.org" },
    });
    expect(await relay.testConnection({ apiKey: "r" })).toMatch(/Connected/);
    expect(calls[1].url).toBe("https://relay.firefox.com/api/v1/profiles/");
  });

  it("Fastmail: JMAP session, then MaskedEmail/set; reports JMAP refusals", async () => {
    let refuse = false;
    const { P, calls } = load({}, (c) => {
      if (c.url.endsWith("/jmap/session"))
        return { json: { username: "ada@fastmail.com", primaryAccounts: { "https://www.fastmail.com/dev/maskedemail": "u123" } } };
      return refuse
        ? { json: { methodResponses: [["MaskedEmail/set", { notCreated: { new: { description: "Too many" } } }, "0"]] } }
        : {
            json: { methodResponses: [["MaskedEmail/set", { created: { new: { id: "m1", email: "fuzzy.cat1234@fastmail.com" } } }, "0"]] },
          };
    });
    const fm = P.get("fastmail");
    expect(await fm.createAlias({ apiKey: "f" }, ctx)).toEqual({ email: "fuzzy.cat1234@fastmail.com", id: "m1" });
    expect(calls[0]).toMatchObject({ url: "https://api.fastmail.com/jmap/session", headers: { authorization: "Bearer f" } });
    const [method, args] = calls[1].body.methodCalls[0];
    expect(calls[1].url).toBe("https://api.fastmail.com/jmap/api/");
    expect(calls[1].body.using).toContain("https://www.fastmail.com/dev/maskedemail");
    expect(method).toBe("MaskedEmail/set");
    expect(args).toEqual({ accountId: "u123", create: { new: { state: "enabled", forDomain: ctx.url, description: ctx.note } } });
    refuse = true;
    await expect(fm.createAlias({ apiKey: "f" }, ctx)).rejects.toThrow("Too many");
    expect(await fm.testConnection({ apiKey: "f" })).toMatch(/ada@fastmail\.com/);
  });

  it("Fastmail: a token without the Masked Email scope is refused", async () => {
    const { P } = load({}, () => ({ json: { primaryAccounts: {} } }));
    await expect(P.get("fastmail").testConnection({ apiKey: "f" })).rejects.toThrow(/Masked Email/);
  });

  it("Forward Email: Basic auth with the token as user name, random alias on the domain", async () => {
    const { P, calls } = load({}, (c) =>
      c.method === "POST" ? { json: { id: "a1", name: "k8s2j", domain: { name: "example.net" } } } : { json: { email: "ada@example.org" } },
    );
    const fe = P.get("forward-email");
    const cfg = { apiKey: "tok", domain: "Example.net" };
    expect(await fe.createAlias(cfg, ctx)).toEqual({ email: "k8s2j@example.net", id: "a1" });
    expect(calls[0]).toMatchObject({
      url: "https://api.forwardemail.net/v1/domains/example.net/aliases",
      headers: { authorization: `Basic ${btoa("tok:")}` },
      body: { labels: "shop.example.org", description: ctx.note },
    });
    expect(await fe.testConnection(cfg)).toMatch(/ada@example\.org/);
    expect(calls[1].url).toBe("https://api.forwardemail.net/v1/account");
  });

  it("DuckDuckGo (experimental): Bearer token, address@duck.com, no network to test", async () => {
    const { P, calls } = load({}, () => ({ status: 201, json: { address: "brisk-otter-lamp" } }));
    const ddg = P.get("duckduckgo");
    expect(ddg.experimental).toBe(true);
    expect(await ddg.createAlias({ apiKey: "d" }, ctx)).toEqual({ email: "brisk-otter-lamp@duck.com" });
    expect(calls[0]).toMatchObject({
      url: "https://quack.duckduckgo.com/api/email/addresses",
      method: "POST",
      headers: { authorization: "Bearer d" },
    });
    await ddg.testConnection({ apiKey: "d" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces the provider's own error and maps 401 to an invalid-key message", async () => {
    const { P } = load({ aliasProvider: "simplelogin", providerSettings: { simplelogin: { apiKey: "bad" } } }, () => ({
      status: 401,
      json: { error: "Wrong api key" },
    }));
    const err = await P.createAlias("https://shop.example.org/").catch((e: any) => e);
    expect(err.message).toBe("Wrong api key");
    expect(err.status).toBe(401);
    expect(P.errorMessage(P.get("simplelogin"), err)).toBe("Invalid SimpleLogin API key.");
    const { P: P2 } = load({ aliasProvider: "addy", providerSettings: { addy: { apiKey: "t", domain: "anonaddy.me" } } }, () => ({
      status: 422,
      json: { message: "The domain is invalid" },
    }));
    await expect(P2.createAlias("https://shop.example.org/")).rejects.toThrow("The domain is invalid");
  });

  it("refuses plain-http provider URLs except on localhost", () => {
    const { P } = load();
    expect(() => P.normalizeBaseUrl("http://sl.example.org")).toThrow(/HTTPS/);
    expect(P.normalizeBaseUrl("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(P.originPattern(P.get("throwaway"), { server: "https://mail.example.test" })).toBe("https://mail.example.test/*");
  });
});
