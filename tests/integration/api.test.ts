import { beforeEach, describe, expect, it } from "vitest";
import { Client, addDomain, fixture, ingest, inviteUser, makeTestApp, setupAdmin, simpleEml, type TestApp } from "../helpers.js";
import { runRetention } from "../../app/server/services/retention.js";

let t: TestApp;
let admin: Client;

beforeEach(async () => {
  t = makeTestApp();
  admin = await setupAdmin(t);
  await addDomain(admin);
});

async function apiClient(c: Client) {
  const k = await c.post("/v1/keys", { name: "test" });
  expect(k.status).toBe(201);
  const api = new Client(t);
  api.bearer = k.json.key;
  return api;
}

describe("acceptance: create address → mail → code via long-poll", () => {
  it("returns the code that arrives while waiting", async () => {
    const api = await apiClient(admin);
    const created = await api.post("/v1/addresses", { site_name: "Google", site_url: "https://accounts.google.com" });
    expect(created.status).toBe(201);
    expect(created.json.email).toMatch(/^[a-z]+-[a-z]+-\d{4}@mail\.example\.test$/);
    const since = Date.now() - 1;
    const pending = api.get(`/v1/addresses/${created.json.id}/code?wait=10&since=${since}`);
    await new Promise((r) => setTimeout(r, 200));
    await ingest(t, created.json.email, fixture("google-verification-code.eml"));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.json.code).toBe("482913");
    expect(r.json.confidence).toBeGreaterThan(0.3);
    expect(r.json.message_id).toMatch(/^msg_/);
  });

  it("returns immediately when a code already exists, 204 on timeout otherwise", async () => {
    const api = await apiClient(admin);
    const a = (await api.post("/v1/addresses", { site_name: "X" })).json;
    expect((await api.get(`/v1/addresses/${a.id}/code?wait=1`)).status).toBe(204);
    const m = await ingest(t, a.email, fixture("x-verification-subject.eml"));
    const r = await api.get(`/v1/addresses/${a.id}/code?wait=5`);
    expect(r.json.code).toBe("482910");
    // since=<message id> waits for a newer one
    expect((await api.get(`/v1/addresses/${a.id}/code?wait=1&since=${m.json.message_id}`)).status).toBe(204);
  });

  it("returns links for link-only mails unless require=code", async () => {
    const api = await apiClient(admin);
    const a = (await api.post("/v1/addresses", { site_name: "Linear" })).json;
    await ingest(t, a.email, fixture("magic-link-only.eml"));
    const r = await api.get(`/v1/addresses/${a.id}/code`);
    expect(r.json.code).toBeNull();
    expect(r.json.links[0].url).toContain("linear.app/auth/magic-link");
    expect((await api.get(`/v1/addresses/${a.id}/code?require=code`)).status).toBe(204);
  });
});

describe("addresses", () => {
  it("creates, lists, filters, renames, pauses, archives and deletes", async () => {
    const a = (await admin.post("/v1/addresses", { site_name: "Shop", site_url: "shop.example", local_part: "my-shop" })).json;
    expect(a.email).toBe("my-shop@mail.example.test");
    expect(a.address.site_url).toBe("https://shop.example");
    expect((await admin.post("/v1/addresses", { site_name: "Dup", local_part: "my-shop" })).status).toBe(409);
    expect((await admin.post("/v1/addresses", { site_name: "Bad", local_part: "_x" })).status).toBe(400);
    await admin.post("/v1/addresses", { site_name: "Forum" });
    expect((await admin.get("/v1/addresses?site=shop")).json.addresses).toHaveLength(1);
    expect((await admin.get("/v1/addresses?q=forum")).json.addresses).toHaveLength(1);
    const renamed = await admin.patch(`/v1/addresses/${a.id}`, { site_name: "Shop renamed", status: "paused" });
    expect(renamed.json.address).toMatchObject({ site_name: "Shop renamed", status: "paused" });
    expect((await admin.get("/v1/addresses?status=paused")).json.addresses).toHaveLength(1);
    await admin.patch(`/v1/addresses/${a.id}`, { status: "archived" });
    expect((await admin.get("/v1/addresses")).json.addresses).toHaveLength(1);
    expect((await admin.get("/v1/addresses?status=all")).json.addresses).toHaveLength(2);
    expect((await admin.del(`/v1/addresses/${a.id}`)).status).toBe(200);
    expect((await admin.get(`/v1/addresses/${a.id}`)).status).toBe(404);
  });

  it("tracks unread counts and read state", async () => {
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json;
    const m = await ingest(t, a.email, simpleEml({ text: "Your code is 123456" }));
    expect((await admin.get(`/v1/addresses/${a.id}`)).json.address.unread_count).toBe(1);
    await admin.patch(`/v1/messages/${m.json.message_id}`, { read: true });
    expect((await admin.get(`/v1/addresses/${a.id}`)).json.address.unread_count).toBe(0);
  });

  it("validates input with a consistent error format", async () => {
    const r = await admin.post("/v1/addresses", { site_name: "" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("bad_request");
    expect(Array.isArray(r.json.error.details)).toBe(true);
  });
});

describe("isolation between users", () => {
  it("user B cannot see or touch user A's addresses, messages, keys or destinations", async () => {
    const a = await inviteUser(t, admin, "alice@example.org");
    const b = await inviteUser(t, admin, "bob@example.org");
    const addr = (await a.post("/v1/addresses", { site_name: "Alice site" })).json;
    const msg = await ingest(t, addr.email, simpleEml({ text: "Your code is 654321" }));
    const dest = (await a.post("/v1/destinations", { email: "alice@personal.example" })).json.destination;
    const key = (await a.post("/v1/keys", { name: "alice key" })).json.api_key;

    expect((await b.get("/v1/addresses")).json.addresses).toEqual([]);
    expect((await b.get(`/v1/addresses/${addr.id}`)).status).toBe(404);
    expect((await b.patch(`/v1/addresses/${addr.id}`, { site_name: "pwned" })).status).toBe(404);
    expect((await b.del(`/v1/addresses/${addr.id}`)).status).toBe(404);
    expect((await b.get(`/v1/addresses/${addr.id}/messages`)).status).toBe(404);
    expect((await b.get(`/v1/addresses/${addr.id}/code`)).status).toBe(404);
    expect((await b.get(`/v1/messages/${msg.json.message_id}`)).status).toBe(404);
    expect((await b.del(`/v1/messages/${msg.json.message_id}`)).status).toBe(404);
    expect((await b.get("/v1/destinations")).json.destinations).toEqual([]);
    expect((await b.post(`/v1/destinations/${dest.id}/refresh`)).status).toBe(404);
    expect((await b.del(`/v1/destinations/${dest.id}`)).status).toBe(404);
    expect((await b.get("/v1/keys")).json.keys).toEqual([]);
    expect((await b.del(`/v1/keys/${key.id}`)).status).toBe(404);
    // B cannot attach A's destination to their own address
    const bAddr = (await b.post("/v1/addresses", { site_name: "Bob site" })).json;
    expect((await b.patch(`/v1/addresses/${bAddr.id}`, { destination_id: dest.id })).status).toBe(400);
    // B's long-poll does not wake up for A's mail
    const bApi = await apiClient(b);
    expect((await bApi.get(`/v1/addresses/${addr.id}/code`)).status).toBe(404);
    // A still sees everything intact
    expect((await a.get(`/v1/messages/${msg.json.message_id}`)).json.message.extracted.code.value).toBe("654321");
    // the admin does not see users' private addresses either
    expect((await admin.get("/v1/addresses")).json.addresses.map((x: any) => x.id)).not.toContain(addr.id);
  });
});

describe("auth", () => {
  it("requires the CSRF token for cookie-authenticated writes", async () => {
    const saved = admin.csrf;
    admin.csrf = "";
    const missing = await admin.post("/v1/addresses", { site_name: "x" });
    admin.csrf = "not-the-token";
    const wrong = await admin.post("/v1/addresses", { site_name: "x" });
    admin.csrf = saved;
    expect(missing.status).toBe(403);
    expect(missing.json.error.code).toBe("csrf_failed");
    expect(wrong.status).toBe(403);
    expect((await admin.post("/v1/addresses", { site_name: "x" })).status).toBe(201);
  });

  it("rejects revoked API keys and unknown keys", async () => {
    const k = await admin.post("/v1/keys", { name: "temp" });
    const api = new Client(t);
    api.bearer = k.json.key;
    expect((await api.get("/v1/addresses")).status).toBe(200);
    expect((await admin.get("/v1/keys")).json.keys[0]).not.toHaveProperty("key");
    await admin.del(`/v1/keys/${k.json.api_key.id}`);
    expect((await api.get("/v1/addresses")).status).toBe(401);
    api.bearer = "tm_nope_nope";
    expect((await api.get("/v1/addresses")).status).toBe(401);
  });

  it("keeps admin endpoints admin-only", async () => {
    const u = await inviteUser(t, admin, "user@example.org");
    expect((await u.get("/v1/admin/users")).status).toBe(403);
    expect((await u.post("/v1/domains", { name: "evil.test" })).status).toBe(403);
    expect((await u.post("/v1/admin/invites", {})).status).toBe(403);
  });

  it("logs in and out, rejects wrong passwords, disables users", async () => {
    const u = await inviteUser(t, admin, "carol@example.org");
    const fresh = new Client(t);
    expect((await fresh.post("/v1/auth/login", { email: "carol@example.org", password: "wrong password!" })).status).toBe(401);
    expect((await fresh.post("/v1/auth/login", { email: "carol@example.org", password: "another long password" })).status).toBe(200);
    expect((await fresh.get("/v1/auth/me")).json.user.email).toBe("carol@example.org");
    const me = (await u.get("/v1/auth/me")).json.user;
    await admin.patch(`/v1/admin/users/${me.id}`, { disabled: true });
    expect((await fresh.get("/v1/auth/me")).status).toBe(401);
    expect((await admin.get("/v1/admin/audit")).json.entries.some((e: any) => e.action === "user.updated")).toBe(true);
  });

  it("invites are single use", async () => {
    const inv = await admin.post("/v1/admin/invites", {});
    const c1 = new Client(t);
    expect((await c1.post("/v1/auth/accept-invite", { token: inv.json.token, email: "d@example.org", password: "long enough password" })).status).toBe(201);
    const c2 = new Client(t);
    expect((await c2.post("/v1/auth/accept-invite", { token: inv.json.token, email: "e@example.org", password: "long enough password" })).status).toBe(404);
  });

  it("setup can only run once", async () => {
    const c = new Client(t);
    expect((await c.post("/v1/auth/setup", { token: "x", email: "z@example.org", password: "long enough password" })).status).toBe(409);
  });
});

describe("domains (mock Cloudflare)", () => {
  it("becomes active, reports errors and missing DNS", async () => {
    const list = (await admin.get("/v1/domains")).json.domains;
    expect(list[0]).toMatchObject({ name: "mail.example.test", status: "active" });
    expect(t.cf.zones.get(list[0].cf_zone_id)?.catchAllWorker).toBe("throwaway-mail-ingest");
    const bad = (await admin.post("/v1/domains", { name: "invalid-zone.test" })).json.domain;
    expect(bad.status).toBe("error");
    expect(bad.status_detail).toMatch(/No Cloudflare zone/);
    const nodns = (await admin.post("/v1/domains", { name: "nodns.example.test" })).json.domain;
    expect(nodns.status).toBe("pending");
    expect(nodns.dns_missing.length).toBeGreaterThan(0);
    expect((await admin.post(`/v1/domains/${nodns.id}/verify`)).json.domain.status).toBe("pending");
    expect((await admin.post("/v1/addresses", { site_name: "x", domain: "nodns.example.test" })).status).toBe(400);
  });
});

describe("events", () => {
  it("streams message.received over SSE", async () => {
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json;
    const ac = new AbortController();
    const res = await t.app.request("/v1/events", { headers: { cookie: admin.cookie }, signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await until("event: ready");
    await ingest(t, a.email, simpleEml({ text: "Your code is 123456" }));
    await until("event: message.received");
    expect(buf).toContain(a.id);
    ac.abort();
    await reader.cancel().catch(() => {});
  });
});

describe("retention and docs", () => {
  it("deletes messages older than the retention period", async () => {
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json;
    await ingest(t, a.email, simpleEml({ text: "old" }));
    const realNow = t.deps.now;
    t.deps.now = () => realNow() + 31 * 86400_000;
    expect(runRetention(t.deps)).toBe(1);
    t.deps.now = realNow;
  });
  it("serves the OpenAPI document", async () => {
    const r = await t.app.request("/openapi.json");
    const doc = (await r.json()) as any;
    expect(doc.paths["/v1/addresses/{id}/code"].get.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(["id", "wait", "since"]));
    expect(doc.paths["/v1/addresses"].post.requestBody).toBeTruthy();
  });
  it("sets a strict CSP", async () => {
    const r = await t.app.request("/healthz");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
  });
});
