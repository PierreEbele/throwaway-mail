import { describe, expect, it } from "vitest";
import { addDomain, loginAs, makeTestApp, setupAdmin } from "../helpers.js";
import { EXPIRY_WARNING_MS, pauseExpired, runExpiryReminders } from "../../app/server/services/reminders.js";

async function setup() {
  const clock = { now: Date.now() };
  const t = makeTestApp({}, { now: () => clock.now });
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.deps.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("ok");
  }) as typeof fetch;
  const target = await user.post("/v1/notify-targets", {
    kind: "ntfy",
    name: "Phone",
    url: "https://ntfy.sh/throwaway-test",
    events: ["address.expiring", "address.expired"],
  });
  expect(target.status).toBe(201);
  const flush = () => new Promise((r) => setTimeout(r, 20));
  return { t, user, clock, calls, flush };
}

describe("expiry reminders", () => {
  it("warns once per address within 24 h of its expiry", async () => {
    const { t, user, clock, calls, flush } = await setup();
    const soon = (await user.post("/v1/addresses", { site_name: "Shop", expires_at: clock.now + 5 * 3600_000 })).json.address;
    await user.post("/v1/addresses", { site_name: "Later", expires_at: clock.now + 3 * EXPIRY_WARNING_MS });
    await user.post("/v1/addresses", { site_name: "Forever" });
    const archived = (await user.post("/v1/addresses", { site_name: "Old", expires_at: clock.now + 3600_000 })).json.address;
    expect((await user.patch(`/v1/addresses/${archived.id}`, { status: "archived" })).status).toBe(200);

    expect(runExpiryReminders(t.deps)).toBe(1);
    await flush();
    expect(calls).toHaveLength(1);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.title).toBe("Shop: address expires in 5 h");
    expect(h.click).toBe(`http://localhost:3000/addresses/${soon.id}`);
    expect(String(calls[0]!.init.body)).toContain(soon.email);

    // Not repeated on the next sweep.
    expect(runExpiryReminders(t.deps)).toBe(0);
    // The other address enters the window two days later.
    clock.now += 2 * EXPIRY_WARNING_MS + 3600_000;
    expect(runExpiryReminders(t.deps)).toBe(1);
  });

  it("pauses expired addresses, notifies, and only touches the requested one when given", async () => {
    const { t, user, clock, calls, flush } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "A", expires_at: clock.now + 60_000 })).json.address;
    const b = (await user.post("/v1/addresses", { site_name: "B", expires_at: clock.now + 60_000 })).json.address;
    clock.now += 120_000;
    expect(pauseExpired(t.deps, a.id)).toBe(1);
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ status: "paused", burned: { reason: "expired" } });
    expect((await user.get(`/v1/addresses/${b.id}`)).json.address.status).toBe("active");
    await flush();
    expect((calls[0]!.init.headers as Record<string, string>).title).toBe("A: address expired");
    expect(pauseExpired(t.deps)).toBe(1);
    expect(pauseExpired(t.deps)).toBe(0);
    // Already expired: no "expires soon" reminder.
    expect(runExpiryReminders(t.deps)).toBe(0);
  });
});
