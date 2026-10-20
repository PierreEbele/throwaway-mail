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
