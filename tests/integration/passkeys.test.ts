import { describe, expect, it } from "vitest";
import { Client, loginAs, makeTestApp, type TestApp } from "../helpers.js";
import { FakeAuthenticator } from "../webauthn-fake.js";
import { totp } from "../../app/server/lib/totp.js";
import { auditLog } from "../../app/server/db/schema.js";

const PW = "correct horse battery";
const EMAIL = "root@example.org";

function app(env: Record<string, string> = {}) {
  const clock = { now: 1_700_000_000_000 };
  const t = makeTestApp(env, { now: () => clock.now });
  return { t, clock };
}

async function setup(t: TestApp) {
  const c = new Client(t);
  expect((await c.post("/v1/auth/setup", { email: EMAIL, password: PW })).status).toBe(200);
  return c;
}

async function addPasskey(c: Client, auth: FakeAuthenticator, name = "Laptop") {
  const o = await c.post("/v1/auth/passkeys/options", { password: PW });
  expect(o.status).toBe(200);
  expect(o.json.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  const r = await c.post("/v1/auth/passkeys", { response: auth.create(o.json.options), name });
  expect(r.status).toBe(201);
  return r.json.passkey;
}

async function passkeyLogin(t: TestApp, auth: FakeAuthenticator, uv = true) {
  const c = new Client(t);
  const o = await c.post("/v1/auth/passkey/options");
  expect(o.status).toBe(200);
  expect(o.json.options.allowCredentials).toEqual([]);
  const r = await c.post("/v1/auth/passkey/login", { response: auth.get(o.json.options, uv) });
  return { c, r };
}

const actions = (t: TestApp) =>
  t.deps.db
    .select()
    .from(auditLog)
    .all()
    .map((a) => a.action);

describe("passkeys", () => {
  it("registers a passkey after confirming the password, then signs in without e-mail or password", async () => {
    const { t } = app();
    const c = await setup(t);
    expect((await c.post("/v1/auth/passkeys/options", { password: "wrong-wrong" })).status).toBe(403);
    const auth = new FakeAuthenticator();
    const pk = await addPasskey(c, auth);
    expect(pk).toMatchObject({ name: "Laptop", last_used_at: null });
    expect((await c.get("/v1/auth/passkeys")).json).toMatchObject({ passkeys: [{ id: pk.id }], second_factor: false });

    const { c: c2, r } = await passkeyLogin(t, auth);
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(EMAIL);
    expect((await c2.get("/v1/auth/me")).status).toBe(200);
    expect((await c.get("/v1/auth/passkeys")).json.passkeys[0].last_used_at).not.toBeNull();
    // The password still works, without a second step (passkeys are optional).
    const pw = await new Client(t).post("/v1/auth/login", { email: EMAIL, password: PW });
    expect(pw.json.two_factor_required).toBeUndefined();
    expect(actions(t)).toEqual(expect.arrayContaining(["user.passkey_added", "auth.login"]));
  });

  it("refuses replayed challenges, unknown passkeys, missing user verification and foreign origins", async () => {
    const { t } = app();
    const c = await setup(t);
    const auth = new FakeAuthenticator();
    await addPasskey(c, auth);

    const o = (await new Client(t).post("/v1/auth/passkey/options")).json.options;
    const resp = auth.get(o);
    expect((await new Client(t).post("/v1/auth/passkey/login", { response: resp })).status).toBe(200);
    expect((await new Client(t).post("/v1/auth/passkey/login", { response: resp })).status).toBe(401);

    expect((await passkeyLogin(t, new FakeAuthenticator())).r.status).toBe(401);
    expect((await passkeyLogin(t, auth, false)).r.status).toBe(401);
    const phishing = Object.assign(new FakeAuthenticator("https://evil.example"), {});
    expect((await passkeyLogin(t, phishing)).r.status).toBe(401);
    expect(actions(t).filter((a) => a === "auth.login_failed").length).toBeGreaterThanOrEqual(3);
  });

  it("locks a passkey out after repeated failures", async () => {
    const { t } = app({ LOGIN_MAX_FAILURES: "2" });
    const c = await setup(t);
    const auth = new FakeAuthenticator();
    await addPasskey(c, auth);
    expect((await passkeyLogin(t, auth, false)).r.status).toBe(401);
    expect((await passkeyLogin(t, auth, false)).r.status).toBe(401);
    expect((await passkeyLogin(t, auth)).r.status).toBe(429);
  });

  it("works on every public URL of the app (APP_EXTRA_URLS)", async () => {
    const { t } = app({ APP_EXTRA_URLS: "https://mail.example.net" });
    const c = await setup(t);
    const auth = new FakeAuthenticator("https://mail.example.net");
    const o = await c.req("POST", "/v1/auth/passkeys/options", { password: PW }, { origin: "https://mail.example.net" });
    expect(o.json.options.rp.id).toBe("mail.example.net");
    expect((await c.post("/v1/auth/passkeys", { response: auth.create(o.json.options) })).status).toBe(201);
    const lo = await new Client(t).req("POST", "/v1/auth/passkey/options", undefined, { origin: "https://mail.example.net" });
    expect(lo.json.options.rpId).toBe("mail.example.net");
    expect((await new Client(t).post("/v1/auth/passkey/login", { response: auth.get(lo.json.options) })).status).toBe(200);
  });

  it("can be the second factor instead of TOTP, backed by recovery codes", async () => {
    const { t } = app();
    const c = await setup(t);
    const auth = new FakeAuthenticator();
    expect((await c.post("/v1/auth/passkeys/second-factor", { enabled: true, password: PW })).status).toBe(400);
    await addPasskey(c, auth);
    const on = await c.post("/v1/auth/passkeys/second-factor", { enabled: true, password: PW });
    expect(on.json.recovery_codes).toHaveLength(10);
    expect((await c.get("/v1/auth/me")).json.user.two_factor).toBe(true);

    const step = await new Client(t).post("/v1/auth/login", { email: EMAIL, password: PW });
    expect(step.json).toMatchObject({ two_factor_required: true, methods: ["passkey", "recovery"] });
    const c2 = new Client(t);
    // A TOTP-looking code is refused: there is no authenticator app.
    expect((await c2.post("/v1/auth/login/2fa", { challenge: step.json.challenge, code: "123456" })).status).toBe(401);
    const o = await c2.post("/v1/auth/login/passkey/options", { challenge: step.json.challenge });
    expect(o.json.options.allowCredentials).toEqual([expect.objectContaining({ id: auth.id })]);
    // Without user verification is fine after a password.
    const r = await c2.post("/v1/auth/login/passkey", { challenge: step.json.challenge, response: auth.get(o.json.options, false) });
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(EMAIL);

    // Recovery codes work too.
    const step2 = await new Client(t).post("/v1/auth/login", { email: EMAIL, password: PW });
    const rc = await new Client(t).post("/v1/auth/login/2fa", { challenge: step2.json.challenge, code: on.json.recovery_codes[0] });
    expect(rc.status).toBe(200);

    // A passkey of another account is refused as this account's second factor.
    const other = new FakeAuthenticator();
    const step3 = await new Client(t).post("/v1/auth/login", { email: EMAIL, password: PW });
    const o3 = await new Client(t).post("/v1/auth/login/passkey/options", { challenge: step3.json.challenge });
    expect(
      (await new Client(t).post("/v1/auth/login/passkey", { challenge: step3.json.challenge, response: other.get(o3.json.options) }))
        .status,
    ).toBe(401);
  });

  it("offers both methods with TOTP, and removing the last passkey turns passkey-after-password off", async () => {
    const { t, clock } = app();
    const c = await setup(t);
    const s = await c.post("/v1/auth/2fa/setup", { password: PW });
    await c.post("/v1/auth/2fa/enable", { code: totp(s.json.secret, clock.now) });
    clock.now += 30_000;
    const auth = new FakeAuthenticator();
    const pk = await addPasskey(c, auth);
    expect((await new Client(t).post("/v1/auth/login", { email: EMAIL, password: PW })).json.methods).toEqual([
      "totp",
      "passkey",
      "recovery",
    ]);

    const c3 = await setup(app().t); // independent account on another instance: nothing shared
    expect((await c3.get("/v1/auth/passkeys")).json.passkeys).toEqual([]);

    expect((await c.req("DELETE", `/v1/auth/passkeys/${pk.id}`, { password: "nope-nope" })).status).toBe(403);
    expect((await c.req("DELETE", `/v1/auth/passkeys/${pk.id}`, { code: totp(s.json.secret, clock.now) })).status).toBe(200);
    expect((await c.get("/v1/auth/passkeys")).json.passkeys).toEqual([]);
    expect((await passkeyLogin(t, auth)).r.status).toBe(401);
    expect(actions(t)).toContain("user.passkey_removed");
  });

  it("is for local accounts only", async () => {
    const { t } = app();
    const sso = loginAs(t, "sso@example.org");
    expect((await sso.get("/v1/auth/passkeys")).status).toBe(400);
  });
});
