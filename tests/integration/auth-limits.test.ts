import { describe, expect, it } from "vitest";
import { Client, makeTestApp } from "../helpers.js";
import { AuthLimits, RateLimiter, SlidingWindowLimiter } from "../../app/server/auth/ratelimit.js";

const PW = "correct horse battery";

function limitedApp(opts: Partial<ConstructorParameters<typeof AuthLimits>[0]> = {}) {
  const clock = { now: 1_000_000 };
  const authLimits = new AuthLimits({ ipLimit: 1000, ipWindowMs: 60_000, accountFailures: 3, accountWindowMs: 600_000, ...opts });
  const t = makeTestApp({}, { authLimits, now: () => clock.now });
  return { t, clock };
}

describe("sliding window limiter", () => {
  it("allows `limit` events per window and frees slots as they age out", () => {
    const l = new SlidingWindowLimiter(2, 10_000);
    expect(l.hit("k", 0)).toBe(0);
    expect(l.hit("k", 4_000)).toBe(0);
    expect(l.hit("k", 5_000)).toBe(5); // oldest event (t=0) leaves the window at 10s
    expect(l.hit("k", 10_000)).toBe(0);
    expect(l.hit("other", 10_000)).toBe(0);
    l.reset("k");
    expect(l.retryAfter("k", 10_001)).toBe(0);
  });
});

describe("fixed window limiter", () => {
  it("limits per key and keeps its memory bounded", () => {
    const l = new RateLimiter(2, 10_000, 100);
    expect(l.hit("k", 0).ok).toBe(true);
    expect(l.hit("k", 1).ok).toBe(true);
    expect(l.hit("k", 2)).toMatchObject({ ok: false, retryAfter: 10 });
    expect(l.hit("k", 10_000).ok).toBe(true);
    // Many distinct keys, however long, never grow the map past its cap...
    for (let i = 0; i < 1_000; i++) l.hit(`compat:${String(i).padStart(16_000, "x")}`, 10_000 + i);
    expect(l.size).toBe(100);
    // ...and finished windows are swept by time, whatever the size.
    l.hit("late", 30_000);
    expect(l.size).toBe(1);
  });
});

describe("login lockout", () => {
  it("locks an account after repeated failures, even with the right password, then unlocks", async () => {
    const { t, clock } = limitedApp();
    expect((await new Client(t).post("/v1/auth/setup", { email: "root@example.org", password: PW })).status).toBe(200);
    const c = new Client(t);
    for (let i = 0; i < 3; i++)
      expect((await c.post("/v1/auth/login", { email: "root@example.org", password: "wrong-password" })).status).toBe(401);
    const locked = await c.post("/v1/auth/login", { email: "ROOT@example.org", password: PW });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBe(600);
    // Another account is unaffected.
    expect((await c.post("/v1/auth/login", { email: "other@example.org", password: "x" })).status).toBe(401);
    clock.now += 600_000;
    expect((await c.post("/v1/auth/login", { email: "root@example.org", password: PW })).status).toBe(200);
  });

  it("success clears earlier failures", async () => {
    const { t } = limitedApp();
    await new Client(t).post("/v1/auth/setup", { email: "root@example.org", password: PW });
    const c = new Client(t);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 2; i++) await c.post("/v1/auth/login", { email: "root@example.org", password: "nope-nope-nope" });
      expect((await c.post("/v1/auth/login", { email: "root@example.org", password: PW })).status).toBe(200);
    }
  });

  it("limits setup and invite acceptance per IP", async () => {
    const { t } = limitedApp({ ipLimit: 2 });
    const c = new Client(t);
    expect((await c.post("/v1/auth/invite/nope", { password: PW })).status).toBe(404);
    expect((await c.get("/v1/auth/invite/nope")).status).toBe(200);
    const r = await c.post("/v1/auth/setup", { email: "root@example.org", password: PW });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("locks invite guessing after repeated bad tokens", async () => {
    const { t } = limitedApp();
    const c = new Client(t);
    for (let i = 0; i < 3; i++) expect((await c.post(`/v1/auth/invite/bad${i}`, { password: PW })).status).toBe(404);
    expect((await c.post("/v1/auth/invite/bad9", { password: PW })).status).toBe(429);
  });

  it("locks password changes after repeated wrong current passwords", async () => {
    const { t } = limitedApp();
    const c = new Client(t);
    await c.post("/v1/auth/setup", { email: "root@example.org", password: PW });
    for (let i = 0; i < 3; i++)
      expect((await c.post("/v1/auth/password", { current_password: "wrong-wrong", new_password: "another long one" })).status).toBe(403);
    expect((await c.post("/v1/auth/password", { current_password: PW, new_password: "another long one" })).status).toBe(429);
  });
});
