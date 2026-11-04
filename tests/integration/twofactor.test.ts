import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp, type TestApp } from "../helpers.js";
import { totp } from "../../app/server/lib/totp.js";
import { users } from "../../app/server/db/schema.js";

const PW = "correct horse battery";
const APP_SECRET = "an-app-secret-of-at-least-32-characters!";

function app(env: Record<string, string> = {}) {
  const clock = { now: 1_700_000_000_000 };
  const t = makeTestApp(env, { now: () => clock.now });
  return { t, clock };
}

async function setup(t: TestApp) {
  const c = new Client(t);
  expect((await c.post("/v1/auth/setup", { email: "root@example.org", password: PW })).status).toBe(200);
  return c;
}

/** Enrols the client's account; returns the secret and recovery codes. */
async function enrol(c: Client, clock: { now: number }) {
  const s = await c.post("/v1/auth/2fa/setup", { password: PW });
  expect(s.status).toBe(200);
  expect(s.json.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
  const secret = s.json.secret as string;
  const e = await c.post("/v1/auth/2fa/enable", { code: totp(secret, clock.now) });
  expect(e.status).toBe(200);
  expect(e.json.recovery_codes).toHaveLength(10);
  clock.now += 30_000;
  return { secret, codes: e.json.recovery_codes as string[] };
}

async function passwordStep(t: TestApp) {
  const c = new Client(t);
  const r = await c.post("/v1/auth/login", { email: "root@example.org", password: PW });
  return { c, r };
}

describe("two-factor authentication", () => {
  it("leaves login unchanged until enabled", async () => {
    const { t, clock } = app();
    const c = await setup(t);
    expect((await c.get("/v1/auth/2fa")).json).toMatchObject({ enabled: false, pending: false });
    // Starting setup without confirming does not change login.
    const s = await c.post("/v1/auth/2fa/setup", { password: PW });
    expect((await c.get("/v1/auth/2fa")).json.pending).toBe(true);
    expect((await c.post("/v1/auth/2fa/enable", { code: "000000" })).status).toBe(403);
    const { r } = await passwordStep(t);
    expect(r.json.user.email).toBe("root@example.org");
    expect(r.json.two_factor_required).toBeUndefined();
    expect(totp(s.json.secret, clock.now)).toMatch(/^\d{6}$/);
  });

  it("refuses setup with a wrong password", async () => {
    const { t } = app();
    const c = await setup(t);
    expect((await c.post("/v1/auth/2fa/setup", { password: "wrong-wrong" })).status).toBe(403);
  });

  it("requires a code after the password, and accepts each code once", async () => {
    const { t, clock } = app();
    const c = await setup(t);
    const { secret } = await enrol(c, clock);
    expect((await c.get("/v1/auth/me")).json.user.two_factor).toBe(true);

    const { c: c2, r } = await passwordStep(t);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ two_factor_required: true });
    expect(r.json.user).toBeUndefined();
    expect(c2.cookie).toBe("");
    expect((await c2.post("/v1/auth/login/2fa", { challenge: r.json.challenge, code: "123456" })).status).toBe(401);
    const code = totp(secret, clock.now);
    const ok = await c2.post("/v1/auth/login/2fa", { challenge: r.json.challenge, code });
    expect(ok.status).toBe(200);
    expect((await c2.get("/v1/auth/me")).json.user.email).toBe("root@example.org");
    // Challenge is single-use; the same code cannot be replayed with a new challenge.
    expect((await c2.post("/v1/auth/login/2fa", { challenge: r.json.challenge, code })).status).toBe(401);
    const again = await passwordStep(t);
    expect((await again.c.post("/v1/auth/login/2fa", { challenge: again.r.json.challenge, code })).status).toBe(401);
  });

  it("expires challenges and limits attempts per challenge", async () => {
    const { t, clock } = app();
    const c = await setup(t);
    const { secret } = await enrol(c, clock);
    const { c: c2, r } = await passwordStep(t);
    clock.now += 6 * 60_000;
    expect((await c2.post("/v1/auth/login/2fa", { challenge: r.json.challenge, code: totp(secret, clock.now) })).json.error.code).toBe(
      "challenge_expired",
    );
    const p = await passwordStep(t);
    for (let i = 0; i < 5; i++) await p.c.post("/v1/auth/login/2fa", { challenge: p.r.json.challenge, code: "000000" });
    const res = await p.c.post("/v1/auth/login/2fa", { challenge: p.r.json.challenge, code: totp(secret, clock.now) });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("challenge_expired");
  });

  it("locks the second factor after repeated failures across challenges", async () => {
    const { t, clock } = app({ LOGIN_MAX_FAILURES: "3" });
    const c = await setup(t);
    const { secret } = await enrol(c, clock);
    for (let i = 0; i < 3; i++) {
      const p = await passwordStep(t);
      expect((await p.c.post("/v1/auth/login/2fa", { challenge: p.r.json.challenge, code: "000000" })).status).toBe(401);
    }
    const p = await passwordStep(t);
    const res = await p.c.post("/v1/auth/login/2fa", { challenge: p.r.json.challenge, code: totp(secret, clock.now) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("accepts each recovery code once and can regenerate them", async () => {
    const { t, clock } = app();
    const c = await setup(t);
    const { codes } = await enrol(c, clock);
    const p = await passwordStep(t);
    expect((await p.c.post("/v1/auth/login/2fa", { challenge: p.r.json.challenge, code: codes[0]!.toUpperCase() })).status).toBe(200);
    expect((await c.get("/v1/auth/2fa")).json.recovery_codes_left).toBe(9);
    const p2 = await passwordStep(t);
    expect((await p2.c.post("/v1/auth/login/2fa", { challenge: p2.r.json.challenge, code: codes[0] })).status).toBe(401);

    expect((await c.post("/v1/auth/2fa/recovery-codes", { password: "wrong-wrong" })).status).toBe(403);
    const fresh = await c.post("/v1/auth/2fa/recovery-codes", { password: PW });
    expect(fresh.json.recovery_codes).toHaveLength(10);
    const p3 = await passwordStep(t);
    expect((await p3.c.post("/v1/auth/login/2fa", { challenge: p3.r.json.challenge, code: codes[1] })).status).toBe(401);
    expect((await p3.c.post("/v1/auth/login/2fa", { challenge: p3.r.json.challenge, code: fresh.json.recovery_codes[0] })).status).toBe(
      200,
    );
  });

  it("is turned off with the password or a code", async () => {
    const { t, clock } = app();
    const c = await setup(t);
    const { secret } = await enrol(c, clock);
    expect((await c.post("/v1/auth/2fa/disable", { code: "000000" })).status).toBe(403);
    expect((await c.post("/v1/auth/2fa/disable", { code: totp(secret, clock.now) })).status).toBe(200);
    expect((await passwordStep(t)).r.json.user.two_factor).toBe(false);
    await enrol(c, clock);
    expect((await c.post("/v1/auth/2fa/disable", { password: PW })).status).toBe(200);
    expect((await c.get("/v1/auth/2fa")).json.enabled).toBe(false);
  });

  it("can be reset by an admin, and is audited", async () => {
    const { t, clock } = app();
    const admin = await setup(t);
    const inv = await admin.post("/v1/admin/invites", { email: "u@example.org" });
    const u = new Client(t);
    await u.post(`/v1/auth/invite/${inv.json.url.split("/invite/")[1]}`, { password: PW });
    await enrol(u, clock);
    const id = (await u.get("/v1/auth/me")).json.user.id;
    expect((await u.del(`/v1/admin/users/${id}/2fa`)).status).toBe(403);
    const r = await admin.del(`/v1/admin/users/${id}/2fa`);
    expect(r.status).toBe(200);
    expect(r.json.user.two_factor).toBe(false);
    const login = await new Client(t).post("/v1/auth/login", { email: "u@example.org", password: PW });
    expect(login.json.user.email).toBe("u@example.org");
    const actions = (await admin.get("/v1/admin/audit?limit=100")).json.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["user.2fa_enabled", "user.2fa_reset"]));
  });

  it("stores the secret encrypted when APP_SECRET is set, plain otherwise", async () => {
    const envs: Record<string, string>[] = [{ APP_SECRET }, {}];
    for (const env of envs) {
      const { t, clock } = app(env);
      const c = await setup(t);
      const { secret } = await enrol(c, clock);
      const row = t.deps.db.select().from(users).where(eq(users.email, "root@example.org")).get()!;
      if ("APP_SECRET" in env) {
        expect(row.totpSecret).toMatch(/^v1:/);
        expect(row.totpSecret).not.toContain(secret);
      } else expect(row.totpSecret).toBe(secret);
      const p = await passwordStep(t);
      expect((await p.c.post("/v1/auth/login/2fa", { challenge: p.r.json.challenge, code: totp(secret, clock.now) })).status).toBe(200);
    }
  });

  it("is not available to SSO accounts", async () => {
    const { t } = app();
    await setup(t);
    const { loginAs } = await import("../helpers.js");
    const sso = loginAs(t, "sso@example.org");
    expect((await sso.get("/v1/auth/2fa")).status).toBe(400);
  });
});
