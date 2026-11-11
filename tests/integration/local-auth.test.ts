import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_USERS, startFakeIdp } from "../../scripts/fake-idp.js";
import { Client, makeTestApp, type TestApp } from "../helpers.js";
import { hashPassword, verifyPassword } from "../../app/server/auth/passwords.js";
import { loadConfig } from "../../app/server/config.js";

const PW = "correct horse battery";

async function setup(t: TestApp, email = "root@example.org") {
  const c = new Client(t);
  const r = await c.post("/v1/auth/setup", { email, name: "Root", password: PW });
  expect(r.status).toBe(200);
  return c;
}

async function login(t: TestApp, email: string, password = PW) {
  const c = new Client(t);
  const r = await c.post("/v1/auth/login", { email, password });
  return { c, r };
}

/** Admin creates an invite; returns the token from the link. */
async function invite(admin: Client, email: string, role = "user") {
  const r = await admin.post("/v1/admin/invites", { email, role });
  expect(r.status).toBe(201);
  return (r.json.url as string).split("/invite/")[1]!;
}

describe("password hashing", () => {
  it("uses the scrypt format and verifies only the right password", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("hunter2hunter2", h)).toBe(true);
    expect(await verifyPassword("hunter2hunter3", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("configuration", () => {
  it("enables local login automatically without SSO and refuses having no login method", () => {
    expect(loadConfig({}).localLoginEnabled).toBe(true);
    expect(loadConfig({ OIDC_ISSUER: "https://idp.test", OIDC_CLIENT_SECRET: "s" }).localLoginEnabled).toBe(false);
    expect(loadConfig({ OIDC_ISSUER: "https://idp.test", OIDC_CLIENT_SECRET: "s", LOCAL_LOGIN: "true" }).localLoginEnabled).toBe(true);
    expect(() => loadConfig({ LOCAL_LOGIN: "false" })).toThrow(/No way to log in/);
  });
});

describe("first-run setup", () => {
  it("creates the first admin once, then is refused", async () => {
    const t = makeTestApp();
    const anon = new Client(t);
    expect((await anon.get("/v1/auth/status")).json.local).toEqual({ enabled: true, setup_required: true });
    const admin = await setup(t);
    const me = (await admin.get("/v1/auth/me")).json.user;
    expect(me).toMatchObject({ email: "root@example.org", role: "admin", auth: "local" });
    expect((await anon.get("/v1/auth/status")).json.local.setup_required).toBe(false);
    expect((await anon.post("/v1/auth/setup", { email: "x@example.org", password: PW })).status).toBe(403);
  });

  it("rejects short passwords", async () => {
    const t = makeTestApp();
    expect((await new Client(t).post("/v1/auth/setup", { email: "a@example.org", password: "short" })).status).toBe(400);
  });
});

describe("password login", () => {
  it("only accepts a JSON body sent as application/json", async () => {
    const t = makeTestApp();
    await setup(t);
    const post = (type: string | null, body: string) =>
      t.app.request("/v1/auth/login", { method: "POST", headers: type ? { "content-type": type } : {}, body });
    // What a cross-site HTML form can send without a preflight: a text/plain body shaped like JSON.
    const form = await post("text/plain", `{"email":"root@example.org","password":"${PW}","x":"="}`);
    expect(form.status).toBe(415);
    expect(form.headers.get("set-cookie")).toBeNull();
    expect((await post(null, JSON.stringify({ email: "root@example.org", password: PW }))).status).toBe(415);
    expect((await post("application/x-www-form-urlencoded", "email=root%40example.org")).status).toBe(415);
    const ok = await post("Application/JSON; charset=utf-8", JSON.stringify({ email: "root@example.org", password: PW }));
    expect(ok.status).toBe(200);
  });

  it("signs in with the right password and gives one generic error otherwise", async () => {
    const t = makeTestApp();
    await setup(t);
    const ok = await login(t, "ROOT@example.org");
    expect(ok.r.status).toBe(200);
    expect(ok.r.headers.get("set-cookie")).toMatch(/tm_session=.*HttpOnly/i);
    expect((await ok.c.get("/v1/auth/me")).json.user.email).toBe("root@example.org");
    const wrong = await login(t, "root@example.org", "not the password");
    const unknown = await login(t, "nobody@example.org");
    expect(wrong.r.status).toBe(401);
    expect(unknown.r.status).toBe(401);
    expect(wrong.r.json.error.message).toBe(unknown.r.json.error.message);
  });

  it("is rate limited per IP", async () => {
    const t = makeTestApp({ LOGIN_RATE_LIMIT_PER_MINUTE: "3" });
    for (let i = 0; i < 3; i++) expect((await login(t, "a@example.org")).r.status).toBe(401);
    const r = await login(t, "a@example.org");
    expect(r.r.status).toBe(429);
    expect(r.r.headers.get("retry-after")).toBeTruthy();
  });

  it("refuses disabled accounts", async () => {
    const t = makeTestApp();
    const admin = await setup(t);
    const token = await invite(admin, "u@example.org");
    const u = await new Client(t).post(`/v1/auth/invite/${token}`, { password: PW });
    await admin.patch(`/v1/admin/users/${u.json.user.id}`, { disabled: true });
    expect((await login(t, "u@example.org")).r.status).toBe(403);
  });
});

describe("password change", () => {
  it("needs the current password and ends the other sessions", async () => {
    const t = makeTestApp();
    const a = await setup(t);
    const { c: b } = await login(t, "root@example.org");
    expect((await a.post("/v1/auth/password", { current_password: "wrong password", new_password: "a new password" })).status).toBe(403);
    expect((await a.post("/v1/auth/password", { current_password: PW, new_password: "a new password" })).status).toBe(200);
    expect((await a.get("/v1/auth/me")).status).toBe(200);
    expect((await b.get("/v1/auth/me")).status).toBe(401);
    expect((await login(t, "root@example.org")).r.status).toBe(401);
    expect((await login(t, "root@example.org", "a new password")).r.status).toBe(200);
  });
});

describe("invites", () => {
  it("creates a local account from a one-time link", async () => {
    const t = makeTestApp({ APP_URL: "https://mail.example.org" });
    const admin = await setup(t);
    const r = await admin.post("/v1/admin/invites", { email: "New@Example.org", role: "admin" });
    expect(r.json.url).toMatch(/^https:\/\/mail\.example\.org\/invite\/[\w-]{20,}$/);
    const token = r.json.url.split("/invite/")[1];
    expect((await admin.get("/v1/admin/invites")).json.invites).toHaveLength(1);
    const anon = new Client(t);
    expect((await anon.get(`/v1/auth/invite/${token}`)).json).toEqual({
      valid: true,
      email: "new@example.org",
      role: "admin",
      reset: false,
    });
    const accepted = await anon.post(`/v1/auth/invite/${token}`, { name: "New", password: PW });
    expect(accepted.status).toBe(200);
    expect((await anon.get("/v1/auth/me")).json.user).toMatchObject({ email: "new@example.org", name: "New", role: "admin" });
    // single use
    expect((await anon.get(`/v1/auth/invite/${token}`)).json.valid).toBe(false);
    expect((await new Client(t).post(`/v1/auth/invite/${token}`, { password: PW })).status).toBe(404);
    expect((await admin.get("/v1/admin/invites")).json.invites).toHaveLength(0);
  });

  it("expires after 7 days and can be revoked", async () => {
    const t = makeTestApp();
    const admin = await setup(t);
    const token = await invite(admin, "late@example.org");
    t.deps.db.$client.prepare("update invites set expires_at = ?").run(Date.now() - 1);
    expect((await new Client(t).post(`/v1/auth/invite/${token}`, { password: PW })).status).toBe(404);
    await invite(admin, "gone@example.org");
    const pending = (await admin.get("/v1/admin/invites")).json.invites;
    expect(pending).toHaveLength(1);
    expect((await admin.del(`/v1/admin/invites/${pending[0].id}`)).status).toBe(200);
    expect((await admin.get("/v1/admin/invites")).json.invites).toHaveLength(0);
  });

  it("is admin only", async () => {
    const t = makeTestApp();
    const admin = await setup(t);
    const token = await invite(admin, "u@example.org");
    const user = new Client(t);
    await user.post(`/v1/auth/invite/${token}`, { password: PW });
    expect((await user.post("/v1/admin/invites", { email: "x@example.org" })).status).toBe(403);
    expect((await user.get("/v1/admin/invites")).status).toBe(403);
  });

  it("works as a password reset link for an existing local account", async () => {
    const t = makeTestApp();
    const admin = await setup(t);
    await new Client(t).post(`/v1/auth/invite/${await invite(admin, "u@example.org")}`, { password: PW });
    const { c: old } = await login(t, "u@example.org");
    const token = await invite(admin, "u@example.org", "admin");
    expect((await new Client(t).get(`/v1/auth/invite/${token}`)).json).toMatchObject({ valid: true, role: "user", reset: true });
    const r = await new Client(t).post(`/v1/auth/invite/${token}`, { password: "brand new password" });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe("user");
    expect((await old.get("/v1/auth/me")).status).toBe(401);
    expect((await login(t, "u@example.org", "brand new password")).r.status).toBe(200);
  });
});

describe("roles of local accounts", () => {
  it("can be changed by an admin, but never demote the last admin", async () => {
    const t = makeTestApp();
    const admin = await setup(t);
    const me = (await admin.get("/v1/auth/me")).json.user;
    expect((await admin.patch(`/v1/admin/users/${me.id}`, { role: "user" })).status).toBe(400);
    const u = await new Client(t).post(`/v1/auth/invite/${await invite(admin, "u@example.org")}`, { password: PW });
    const promoted = await admin.patch(`/v1/admin/users/${u.json.user.id}`, { role: "admin" });
    expect(promoted.json.user.role).toBe("admin");
    expect((await admin.patch(`/v1/admin/users/${me.id}`, { role: "user" })).json.user.role).toBe("user");
  });
});

describe("mixed mode (SSO and local accounts)", () => {
  let idp: Awaited<ReturnType<typeof startFakeIdp>>;
  beforeAll(async () => {
    idp = await startFakeIdp({ clientId: "throwaway-mail", clientSecret: "test-oidc-secret" });
  });
  afterAll(() => idp.close());

  const app = () =>
    makeTestApp({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_SECRET: "test-oidc-secret", OIDC_ALLOW_INSECURE: "1", LOCAL_LOGIN: "true" });

  async function ssoCallback(t: TestApp) {
    const start = await t.app.request("/v1/auth/oidc/login");
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const cb = new URL(authorize.headers.get("location")!);
    return t.app.request(cb.pathname + cb.search, { headers: { cookie } });
  }

  it("offers both methods and refuses SSO for the e-mail of a local account", async () => {
    const t = app();
    const status = (await new Client(t).get("/v1/auth/status")).json;
    expect(status.sso.enabled).toBe(true);
    expect(status.local).toEqual({ enabled: true, setup_required: true });
    await setup(t, FAKE_USERS.admin!.email);
    idp.setUser(FAKE_USERS.admin!);
    const refused = await ssoCallback(t);
    expect(refused.headers.get("location")).toMatch(/error=local_account_exists/);
    idp.setUser(FAKE_USERS.alice!);
    const ok = await ssoCallback(t);
    expect(ok.headers.get("set-cookie")).toMatch(/tm_session=/);
  });

  it("does not let SSO accounts use passwords or have their role edited", async () => {
    const t = app();
    const admin = await setup(t);
    idp.setUser(FAKE_USERS.alice!);
    await ssoCallback(t);
    const alice = (await admin.get("/v1/admin/users")).json.users.find((u: { email: string }) => u.email === "alice@example.test");
    expect(alice.auth).toBe("sso");
    expect((await admin.patch(`/v1/admin/users/${alice.id}`, { role: "admin" })).status).toBe(400);
    expect((await admin.post("/v1/admin/invites", { email: "alice@example.test" })).status).toBe(409);
    expect((await login(t, "alice@example.test")).r.status).toBe(401);
  });
});
