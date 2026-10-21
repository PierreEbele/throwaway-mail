import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  t.deps.fetch = (async () => new Response("ok")) as typeof fetch;
  const mk = async (extra: Record<string, unknown> = {}) => (await user.post("/v1/addresses", { site_name: "Shop", site_url: "shop.com", ...extra })).json.address;
  return { t, user, mk };
}

describe("address protections", () => {
  it("site lock rejects other senders but keeps the evidence", async () => {
    const { t, user, mk } = await setup();
    const a = await mk();
    await user.patch(`/v1/addresses/${a.id}`, { site_lock: true });
    expect((await ingest(t, a.email, simpleEml({ text: "hi", from: "news@shop.com" }))).json.action).toBe("store_only");
    expect((await ingest(t, a.email, simpleEml({ text: "win", from: "x@casino.biz" }))).json).toMatchObject({ action: "reject", reason: "sender_not_site" });
    const after = (await user.get(`/v1/addresses/${a.id}`)).json.address;
    expect(after.leak.sender).toBe("x@casino.biz");
    expect(after.message_count).toBe(1);
    expect((await user.get("/v1/leaks")).json.leaks[0].sender_domain).toBe("casino.biz");
  });

  it("burns after N mails or after the first code", async () => {
    const { t, user, mk } = await setup();
    const a = await mk();
    await user.patch(`/v1/addresses/${a.id}`, { max_messages: 2 });
    await ingest(t, a.email, simpleEml({ text: "1", from: "a@shop.com" }));
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.status).toBe("active");
    await ingest(t, a.email, simpleEml({ text: "2", from: "a@shop.com" }));
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ status: "paused", burned: { reason: "max_messages" } });
    expect((await ingest(t, a.email, simpleEml({ text: "3", from: "a@shop.com" }))).json.action).toBe("reject");

    const b = await mk();
    await user.patch(`/v1/addresses/${b.id}`, { burn_after_code: true });
    await ingest(t, b.email, simpleEml({ text: "welcome", from: "a@shop.com" }));
    await ingest(t, b.email, simpleEml({ text: "Your verification code is 123456", from: "a@shop.com" }));
    expect((await user.get(`/v1/addresses/${b.id}`)).json.address.burned.reason).toBe("after_code");
    // resuming clears the burn
    expect((await user.patch(`/v1/addresses/${b.id}`, { status: "active" })).json.address.burned).toBe(null);
  });

  it("replaces a leaked address", async () => {
    const { t, user, mk } = await setup();
    const cat = (await user.post("/v1/categories", { name: "Shops" })).json.category;
    const a = await mk({ category_id: cat.id });
    await user.patch(`/v1/addresses/${a.id}`, { pinned: true, site_lock: true });
    await ingest(t, a.email, simpleEml({ text: "x", from: "x@casino.biz" }));
    const r = (await user.post(`/v1/addresses/${a.id}/replace`, {})).json;
    expect(r.address).toMatchObject({ site_name: "Shop", category_id: cat.id, pinned: true, site_lock: true, status: "active" });
    expect(r.address.email).not.toBe(a.email);
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ status: "paused", pinned: false, leak: null });
  });

  it("panic pauses everything and undo restores only those", async () => {
    const { user, mk } = await setup();
    const a = await mk();
    const b = await mk();
    const c = await mk();
    await user.patch(`/v1/addresses/${c.id}`, { status: "paused" });
    expect((await user.post("/v1/panic", {})).json.affected).toBe(2);
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.status).toBe("paused");
    expect((await user.post("/v1/panic", { action: "undo" })).json.affected).toBe(2);
    expect((await user.get(`/v1/addresses/${b.id}`)).json.address.status).toBe("active");
    expect((await user.get(`/v1/addresses/${c.id}`)).json.address.status).toBe("paused");
  });
});

describe("expiry reminders", () => {
  it("reminds once, and extending re-arms the reminder", async () => {
    const { runExpiryReminders } = await import("../../app/server/services/reminders.js");
    const { t, user, mk } = await setup();
    const calls: string[] = [];
    t.deps.fetch = (async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string).type);
      return new Response("ok");
    }) as typeof fetch;
    await user.post("/v1/notify-targets", { kind: "webhook", name: "h", url: "https://h.example.com", events: ["address.expiring"] });
    const a = await mk({ expires_in_days: 1 });
    const far = await mk({ expires_in_days: 5 });
    expect(runExpiryReminders(t.deps)).toBe(1);
    expect(runExpiryReminders(t.deps)).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["address.expiring"]);
    expect((await user.get("/v1/digest")).json.expiring.map((x: any) => x.id).sort()).toEqual([a.id].sort());

    const ext = (await user.post(`/v1/addresses/${a.id}/extend`, { days: 30 })).json.address;
    expect(ext.expires_at).toBeGreaterThan(a.expires_at + 29 * 86400_000);
    expect((await user.post(`/v1/addresses/${far.id}/extend`, { days: null })).json.address.expires_at).toBe(null);
  });
});

describe("smart folders", () => {
  it("filters by unread / code / recency / leak and saves searches", async () => {
    const { t, user, mk } = await setup();
    const a = await mk();
    const b = await mk();
    const c = await mk();
    await ingest(t, a.email, simpleEml({ text: "Your verification code is 991122", from: "a@shop.com" }));
    await ingest(t, b.email, simpleEml({ text: "hello", from: "x@casino.biz" }));
    const ids = async (q: string) => (await user.get(`/v1/addresses?${q}`)).json.addresses.map((x: any) => x.id).sort();
    expect(await ids("has_code=true")).toEqual([a.id]);
    expect(await ids("unread=true")).toEqual([a.id, b.id].sort());
    expect(await ids("leak=true")).toEqual([b.id]);
    expect(await ids("since_hours=24")).toEqual([a.id, b.id].sort());
    expect(await ids("")).toContain(c.id);

    const s = (await user.post("/v1/saved-searches", { name: "Codes", params: { has_code: "true" } })).json.search;
    expect((await user.get("/v1/saved-searches")).json.searches).toEqual([s]);
    expect((await user.del(`/v1/saved-searches/${s.id}`)).status).toBe(200);
    expect((await user.get("/v1/saved-searches")).json.searches).toEqual([]);
  });
});

describe("directories", () => {
  it("creates addresses on the fly for <dir>.<site>", async () => {
    const { t, user } = await setup();
    const other = loginAs(t, "v@example.org");
    const shops = (await user.post("/v1/categories", { name: "Shops", auto_match: "amazon" })).json.category;
    expect((await user.post("/v1/directories", { name: "dory" })).status).toBe(201);
    expect((await other.post("/v1/directories", { name: "dory" })).status).toBe(409);
    expect((await user.post("/v1/directories", { name: "x" })).status).toBe(400);

    expect((await ingest(t, "dory.amazon.fr@mail.example.test", simpleEml({ text: "welcome" }))).json.action).toBe("store_only");
    const list = (await user.get("/v1/addresses")).json.addresses;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: "dory.amazon.fr@mail.example.test", site_name: "amazon.fr", site_url: "https://amazon.fr", category_id: shops.id });
    await ingest(t, "dory.amazon.fr@mail.example.test", simpleEml({ text: "again" }));
    expect((await user.get("/v1/addresses")).json.addresses[0].message_count).toBe(2);
    expect((await ingest(t, "nobody.site@mail.example.test", simpleEml({ text: "x" }))).json.action).toBe("reject");
  });
});
