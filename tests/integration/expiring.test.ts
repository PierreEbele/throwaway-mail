import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { pauseExpired } from "../../app/server/services/reminders.js";

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  t.deps.fetch = (async () => new Response("ok")) as typeof fetch;
  return { t, user };
}

describe("expiring and quota addresses", () => {
  it("accepts max_messages and expiry at creation, and pauses at the quota", async () => {
    const { t, user } = await setup();
    const r = await user.post("/v1/addresses", { site_name: "Shop", max_messages: 1, expires_in_days: 7 });
    expect(r.status).toBe(201);
    const a = r.json.address;
    expect(a.max_messages).toBe(1);
    expect(a.expires_at).toBeGreaterThan(Date.now() + 6 * 86400_000);
    await ingest(t, a.email, simpleEml({ text: "1" }));
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ status: "paused", burned: { reason: "max_messages" } });
    expect((await ingest(t, a.email, simpleEml({ text: "2" }))).json).toMatchObject({ action: "reject", reason: "address_paused" });
  });

  it("pauses an expired address on the next mail, and extending revives it", async () => {
    const { t, user } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "Shop", expires_at: Date.now() + 60_000 })).json.address;
    const real = t.deps.now;
    t.deps.now = () => real() + 120_000;
    expect((await ingest(t, a.email, simpleEml({ text: "late" }))).json).toMatchObject({ action: "reject", reason: "address_expired" });
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ status: "paused", burned: { reason: "expired" } });
    await user.post(`/v1/addresses/${a.id}/extend`, { days: 7 });
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ status: "active", burned: null });
  });

  it("the periodic sweep pauses expired addresses", async () => {
    const { t, user } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "Shop", expires_at: Date.now() + 60_000 })).json.address;
    expect(pauseExpired(t.deps)).toBe(0);
    const real = t.deps.now;
    t.deps.now = () => real() + 120_000;
    expect(pauseExpired(t.deps)).toBe(1);
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.status).toBe("paused");
  });
});
