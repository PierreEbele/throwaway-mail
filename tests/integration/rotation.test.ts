import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { endRotationGrace, runRotations } from "../../app/server/services/rotation.js";

const DAY = 86400_000;

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  const calls: Array<{ url: string; body: string }> = [];
  t.deps.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok");
  }) as typeof fetch;
  // Fake clock: tests move it forward with advance().
  let now = Date.now();
  t.deps.now = () => now;
  const advance = (ms: number) => (now += ms);
  const sweep = () => ({ rotated: runRotations(t.deps), ended: endRotationGrace(t.deps) });
  const flush = () => new Promise((r) => setTimeout(r, 20));
  const mk = async (extra: Record<string, unknown> = {}) =>
    (await user.post("/v1/addresses", { site_name: "Shop", site_url: "shop.com", ...extra })).json.address;
  return { t, user, calls, advance, sweep, flush, mk };
}

describe("scheduled rotation", () => {
  it("rotates N days after a leak, keeps the old address during the grace period, then pauses it", async () => {
    const { t, user, calls, advance, sweep, flush, mk } = await setup();
    await user.post("/v1/notify-targets", { kind: "ntfy", name: "n", url: "https://ntfy.sh/topic", events: ["address.rotated"] });
    const a = await mk({ pinned: true });
    await user.patch(`/v1/addresses/${a.id}`, {
      rotation_mode: "after_leak",
      rotation_days: 2,
      rotation_grace_days: 3,
      block_promos: true,
    });

    advance(5 * DAY);
    expect(sweep().rotated).toBe(0); // no leak yet
    await ingest(t, a.email, simpleEml({ text: "win", from: "x@casino.biz" }), { timestamp: Math.floor(t.deps.now() / 1000) });
    advance(DAY);
    expect(sweep().rotated).toBe(0);
    advance(DAY + 1000);
    expect(sweep().rotated).toBe(1);
    await flush();

    const old = (await user.get(`/v1/addresses/${a.id}`)).json.address;
    expect(old.status).toBe("active");
    expect(old.rotation.grace_until).toBe(t.deps.now() + 3 * DAY);
    const fresh = (await user.get(`/v1/addresses/${old.rotation.rotated_to_id}`)).json.address;
    expect(fresh).toMatchObject({ site_name: "Shop", domain: "mail.example.test", status: "active", block_promos: true, leak: null });
    expect(fresh.rotation).toMatchObject({ mode: "after_leak", days: 2, grace_days: 3 });
    const note = calls.find((c) => c.url.startsWith("https://ntfy.sh"));
    expect(note?.body).toContain(fresh.email);

    // The old address still receives during the grace period.
    expect(
      (await ingest(t, a.email, simpleEml({ text: "still here", from: "news@shop.com" }), { timestamp: Math.floor(t.deps.now() / 1000) }))
        .json.action,
    ).not.toBe("reject");
    expect(sweep()).toEqual({ rotated: 0, ended: 0 }); // not rotated twice
    advance(3 * DAY);
    expect(sweep().ended).toBe(1);
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ status: "paused", burned: { reason: "rotated" } });
    expect(
      (await ingest(t, a.email, simpleEml({ text: "late", from: "news@shop.com" }), { timestamp: Math.floor(t.deps.now() / 1000) })).json
        .action,
    ).toBe("reject");
  });

  it("rotates every N days from the account default, and the new address restarts the cycle", async () => {
    const { user, advance, sweep, mk } = await setup();
    const s = (await user.get("/v1/settings/addresses")).json.settings;
    expect(
      (await user.put("/v1/settings/addresses", { ...s, rotation_mode: "every", rotation_days: 10, rotation_grace_days: 0 })).status,
    ).toBe(200);
    const a = await mk();
    const off = await mk({ site_name: "Other" });
    await user.patch(`/v1/addresses/${off.id}`, { rotation_mode: "off" });

    advance(9 * DAY);
    expect(sweep().rotated).toBe(0);
    advance(DAY);
    expect(sweep().rotated).toBe(1);
    const old = (await user.get(`/v1/addresses/${a.id}`)).json.address;
    expect(old).toMatchObject({ status: "paused", burned: { reason: "rotated" } }); // no grace period
    expect((await user.get(`/v1/addresses/${off.id}`)).json.address.status).toBe("active");

    advance(5 * DAY);
    expect(sweep().rotated).toBe(0);
    advance(5 * DAY);
    expect(sweep().rotated).toBe(1);
  });

  it("does nothing when rotation is off (the default)", async () => {
    const { t, advance, sweep, mk } = await setup();
    const a = await mk();
    await ingest(t, a.email, simpleEml({ text: "win", from: "x@casino.biz" }), { timestamp: Math.floor(t.deps.now() / 1000) });
    advance(400 * DAY);
    expect(sweep()).toEqual({ rotated: 0, ended: 0 });
  });
});
