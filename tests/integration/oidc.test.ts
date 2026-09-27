import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_USERS, startFakeIdp } from "../../scripts/fake-idp.js";
import { Client, makeTestApp, type TestApp } from "../helpers.js";

let idp: Awaited<ReturnType<typeof startFakeIdp>>;

beforeAll(async () => {
  idp = await startFakeIdp({ clientId: "throwaway-mail", clientSecret: "test-oidc-secret" });
});
afterAll(() => idp.close());

function app(extra: Record<string, string> = {}) {
  return makeTestApp({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_SECRET: "test-oidc-secret", OIDC_ALLOW_INSECURE: "1", ...extra });
}

/** Drives the browser side of the flow: app → IdP → app callback. Returns the final redirect and the client. */
async function ssoLogin(t: TestApp, returnTo = "/", tamperState = false, host?: string) {
  const start = await t.app.request(`/v1/auth/oidc/login?return_to=${encodeURIComponent(returnTo)}`, host ? { headers: { host } } : {});
  expect(start.status).toBe(302);
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location")!);
  expect(callback.pathname).toBe("/v1/auth/oidc/callback");
  const res = await t.app.request(callback.pathname + callback.search, { headers: { cookie: tamperState ? "tm_oidc_state=forged" : stateCookie } });
  const client = new Client(t);
  const sc = res.headers.get("set-cookie") ?? "";
  const m = /tm_session=([^;]+)/.exec(sc);
  if (m) client.cookie = `tm_session=${m[1]}`;
  return { status: res.status, location: res.headers.get("location") ?? "", client };
}

describe("single sign-on (OpenID Connect)", () => {
  it("logs in, creates the user and maps the admins group to admin", async () => {
    const t = app();
    idp.setUser(FAKE_USERS.dory!);
    const r = await ssoLogin(t, "/addresses/x");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/addresses/x");
    const me = await r.client.get("/v1/auth/me");
    expect(me.json.user).toMatchObject({ email: "dory@example.test", name: "Dory", role: "admin" });
    expect(me.json.csrf_token).toBeTruthy();
    // second login reuses the same account
    const again = await ssoLogin(t);
    expect((await again.client.get("/v1/auth/me")).json.user.id).toBe(me.json.user.id);
  });

  it("gives non-admin groups the user role and syncs role changes at the next login", async () => {
    const t = app();
    idp.setUser({ ...FAKE_USERS.alice! });
    const first = await ssoLogin(t);
    expect((await first.client.get("/v1/auth/me")).json.user.role).toBe("user");
    idp.setUser({ ...FAKE_USERS.alice!, groups: ["family", "admins"] });
    const second = await ssoLogin(t);
    expect((await second.client.get("/v1/auth/me")).json.user.role).toBe("admin");
  });

  it("refuses users outside OIDC_ALLOWED_GROUPS", async () => {
    const t = app({ OIDC_ALLOWED_GROUPS: "admins" });
    idp.setUser(FAKE_USERS.bob!);
    const r = await ssoLogin(t);
    expect(r.location).toMatch(/^\/login\?error=sso_not_allowed/);
    expect(r.client.cookie).toBe("");
  });

  it("refuses disabled users", async () => {
    const t = app();
    idp.setUser(FAKE_USERS.alice!);
    const ok = await ssoLogin(t);
    const me = (await ok.client.get("/v1/auth/me")).json.user;
    t.deps.db.$client.prepare("update users set disabled = 1 where id = ?").run(me.id);
    const r = await ssoLogin(t);
    expect(r.location).toMatch(/error=account_disabled/);
  });

  it("rejects a callback whose state is not bound to this browser", async () => {
    const t = app();
    idp.setUser(FAKE_USERS.dory!);
    const r = await ssoLogin(t, "/", true);
    expect(r.location).toMatch(/error=sso_state_mismatch/);
    expect(r.client.cookie).toBe("");
  });

  it("passes IdP errors back to the login page", async () => {
    const t = app();
    idp.denyNext("access_denied");
    const r = await ssoLogin(t);
    expect(r.location).toMatch(/^\/login\?error=access_denied/);
  });

  it("sends each public hostname back to its own callback URL", async () => {
    const t = app({ APP_URL: "https://mail.one.test", APP_EXTRA_URLS: "https://mail.two.test" });
    idp.setUser(FAKE_USERS.dory!);
    const viaTwo = await t.app.request("/v1/auth/oidc/login", { headers: { host: "mail.two.test" } });
    expect(new URL(viaTwo.headers.get("location")!).searchParams.get("redirect_uri")).toBe("https://mail.two.test/v1/auth/oidc/callback");
    const viaEvil = await t.app.request("/v1/auth/oidc/login", { headers: { host: "evil.test" } });
    expect(new URL(viaEvil.headers.get("location")!).searchParams.get("redirect_uri")).toBe("https://mail.one.test/v1/auth/oidc/callback");
    const r = await ssoLogin(t, "/", false, "mail.two.test");
    expect(r.status).toBe(302);
    expect(r.client.cookie).toMatch(/^tm_session=/);
  });

  it("never redirects off-site after login", async () => {
    const t = app();
    idp.setUser(FAKE_USERS.dory!);
    for (const evil of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      expect((await ssoLogin(t, evil)).location).toBe("/");
    }
  });

  it("reports a clear error when SSO is not configured", async () => {
    const t = makeTestApp();
    const res = await t.app.request("/v1/auth/oidc/login");
    expect(res.headers.get("location")).toMatch(/error=sso_not_configured/);
    expect(((await (await t.app.request("/v1/auth/status")).json()) as any).sso.enabled).toBe(false);
  });
});
