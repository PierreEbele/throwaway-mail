import { describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config.js";

describe("config", () => {
  it("treats empty variables as unset (Docker Compose passes them as empty strings)", () => {
    const c = loadConfig({ SETUP_TOKEN: "", CF_API_TOKEN: "", RETENTION_DAYS: "" });
    expect(c.SETUP_TOKEN).toBeUndefined();
    expect(c.RETENTION_DAYS).toBe(30);
  });
  it("requires a real ingest secret and Cloudflare credentials in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/INGEST_SECRET/);
    expect(() => loadConfig({ NODE_ENV: "production", INGEST_SECRET: "x".repeat(32) })).toThrow(/CF_API_TOKEN/);
    expect(() => loadConfig({ NODE_ENV: "production", CF_MOCK: "1" })).not.toThrow();
  });
  it("reports invalid values readably", () => {
    expect(() => loadConfig({ APP_URL: "not a url" })).toThrow(/Invalid configuration:\n  APP_URL/);
  });
  it("derives secure cookies from an https APP_URL", () => {
    expect(loadConfig({ APP_URL: "https://a.example" }).cookieSecure).toBe(true);
    expect(loadConfig({ APP_URL: "http://localhost:3000" }).cookieSecure).toBe(false);
  });
});
