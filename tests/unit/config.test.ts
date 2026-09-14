import { describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config.js";

describe("config", () => {
  it("treats empty variables as unset (Docker Compose passes them as empty strings)", () => {
    const c = loadConfig({ OIDC_ISSUER: "", CF_API_TOKEN: "", RETENTION_DAYS: "" });
    expect(c.OIDC_ISSUER).toBeUndefined();
    expect(c.RETENTION_DAYS).toBe(30);
  });
  it("requires a real ingest secret and SSO settings in production; Cloudflare may come later", () => {
    const sso = { OIDC_ISSUER: "https://auth.example.test", OIDC_CLIENT_SECRET: "s".repeat(32) };
    expect(() => loadConfig({ NODE_ENV: "production", ...sso })).toThrow(/INGEST_SECRET/);
    expect(() => loadConfig({ NODE_ENV: "production", INGEST_SECRET: "x".repeat(32) })).toThrow(/OIDC_ISSUER/);
    expect(() => loadConfig({ NODE_ENV: "production", INGEST_SECRET: "x".repeat(32), ...sso })).not.toThrow();
  });
  it("derives the SSO redirect URI and allowed groups", () => {
    const c = loadConfig({ APP_URL: "https://jetable.example.test/", OIDC_ALLOWED_GROUPS: "admins, family ,," });
    expect(c.oidcRedirectUri).toBe("https://jetable.example.test/v1/auth/oidc/callback");
    expect(c.oidcAllowedGroups).toEqual(["admins", "family"]);
  });
  it("reports invalid values readably", () => {
    expect(() => loadConfig({ APP_URL: "not a url" })).toThrow(/Invalid configuration:\n  APP_URL/);
  });
  it("derives secure cookies from an https APP_URL", () => {
    expect(loadConfig({ APP_URL: "https://a.example" }).cookieSecure).toBe(true);
    expect(loadConfig({ APP_URL: "http://localhost:3000" }).cookieSecure).toBe(false);
  });
});
