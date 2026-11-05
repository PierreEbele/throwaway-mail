import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addDomain, makeTestApp, setupAdmin, loginAs } from "../helpers.js";
import { fakeMail } from "../mail-fakes.js";
import { LiveCloudflareClient, UnconfiguredCloudflareClient } from "../../app/server/cloudflare/index.js";
import { domains } from "../../app/server/db/schema.js";
import { runDiagnostics, type Check } from "../../app/server/services/diagnostics/index.js";

/** Outbound fetch for APP_URL / OIDC probes: url → response (anything else fails like an unreachable host). */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const r = routes[url];
    if (!r) throw new TypeError(`fetch failed (${url})`);
    return r();
  }) as typeof fetch;
}

/** Cloudflare API answering from a table of "METHOD path" → result (success envelope) or HTTP status. */
function cfApi(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${u.pathname.replace("/client/v4", "")}`;
    const hit = Object.entries(routes).find(([k]) => k === key);
    if (!hit) return Response.json({ success: false, errors: [{ code: 7003, message: `no route ${key}` }] }, { status: 404 });
    const v = hit[1];
    if (typeof v === "number")
      return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: v });
    return Response.json({ success: true, result: v });
  }) as typeof fetch;
}

const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id);

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tm-diag-"));
}

describe("setup diagnostics", () => {
  it("is admin only and reports a fresh mock install", async () => {
    const t = makeTestApp({ DATA_DIR: tmpDataDir() }, { fetch: fakeFetch({ "http://localhost:3000/healthz": () => new Response("ok") }) });
    const user = loginAs(t, "user@example.org");
    expect((await user.get("/v1/admin/diagnostics")).status).toBe(403);
    const admin = await setupAdmin(t);
    const r = await admin.get("/v1/admin/diagnostics");
    expect(r.status).toBe(200);
    const checks: Check[] = r.json.checks;
    expect(byId(checks, "app_url.https")!.status).toBe("warn");
    expect(byId(checks, "app_url.reachable:http://localhost:3000")!.status).toBe("ok");
    expect(byId(checks, "cloudflare.token")!.status).toBe("warn"); // CF_MOCK
    expect(byId(checks, "domains")!.status).toBe("warn");
    expect(byId(checks, "backups")!.status).toBe("warn");
    expect(byId(checks, "app_secret")!.status).toBe("warn");
    expect(r.json.summary.ok + r.json.summary.warn + r.json.summary.error).toBe(checks.length);
    for (const c of checks) if (c.status !== "ok") expect(c.hint, c.id).toBeTruthy();
  });

  it("checks MX records, Email Routing and the Worker route of each Cloudflare domain", async () => {
    const t = makeTestApp(
      { DATA_DIR: tmpDataDir(), INGEST_SECRET: "0123456789abcdef0123456789abcdef" },
      {
        fetch: fakeFetch({}),
        resolveMx: async (d) =>
          d === "good.example.test"
            ? [{ exchange: "route1.mx.cloudflare.net", priority: 10 }]
            : d === "mixed.example.test"
              ? [
                  { exchange: "route1.mx.cloudflare.net", priority: 10 },
                  { exchange: "mx.oldhost.example", priority: 5 },
                ]
              : [],
      },
    );
    const admin = await setupAdmin(t);
    for (const n of ["good.example.test", "mixed.example.test", "none.example.test"]) await addDomain(admin, n);
    t.deps.db
      .update(domains)
      .set({ lastIngestAt: t.deps.now() - 3600_000 })
      .where(eq(domains.name, "good.example.test"))
      .run();
    // The catch-all of one zone was changed by hand in the Cloudflare dashboard.
    const mixed = t.deps.db.select().from(domains).where(eq(domains.name, "mixed.example.test")).get()!;
    await t.cf.setCatchAll(mixed.cfZoneId!, { enabled: true, actions: [{ type: "drop" }] });

    const { checks } = await runDiagnostics(t.deps);
    expect(byId(checks, "ingest_secret")!.status).toBe("ok");
    expect(byId(checks, "domain.mx:good.example.test")!.status).toBe("ok");
    expect(byId(checks, "domain.mx:mixed.example.test")!).toMatchObject({ status: "warn" });
    expect(byId(checks, "domain.mx:mixed.example.test")!.detail).toContain("mx.oldhost.example");
    expect(byId(checks, "domain.mx:none.example.test")!.status).toBe("error");
    expect(byId(checks, "domain.routing:good.example.test")!.status).toBe("ok");
    expect(byId(checks, "domain.worker_route:good.example.test")!.status).toBe("ok");
    expect(byId(checks, "domain.worker_route:mixed.example.test")!).toMatchObject({ status: "error" });
    expect(byId(checks, "domain.worker_route:mixed.example.test")!.detail).toContain("drop");
    expect(byId(checks, "domain.last_mail:good.example.test")!.status).toBe("ok");
    expect(byId(checks, "domain.last_mail:none.example.test")!.status).toBe("warn");
    // Unreachable public URL is a warning, not an error (hairpin NAT).
    expect(byId(checks, "app_url.reachable:http://localhost:3000")!.status).toBe("warn");
  });

  it("verifies a live Cloudflare token, its permissions and the deployed Worker", async () => {
    const t = makeTestApp({ DATA_DIR: tmpDataDir(), INGEST_SECRET: "dev-ingest-secret-change-me" }, { fetch: fakeFetch({}) });
    const admin = await setupAdmin(t);
    const d = await addDomain(admin, "live.example.test");
    const zone = t.deps.db.select().from(domains).where(eq(domains.id, d.id)).get()!.cfZoneId!;
    t.deps.cf = new LiveCloudflareClient(
      "token",
      "acc",
      cfApi({
        "GET /user/tokens/verify": { status: "active", expires_on: null },
        "GET /accounts/acc/email/routing/addresses": [],
        "GET /accounts/acc/workers/scripts": [{ id: "another-worker" }],
        [`GET /zones/${zone}/email/routing`]: { enabled: false },
        [`GET /zones/${zone}/email/routing/rules/catch_all`]: {
          enabled: true,
          actions: [{ type: "worker", value: ["throwaway-mail-ingest"] }],
        },
      }),
    );
    const { checks } = await runDiagnostics(t.deps);
    expect(byId(checks, "cloudflare.token")!.status).toBe("ok");
    expect(byId(checks, "cloudflare.addresses")!.status).toBe("ok");
    expect(byId(checks, "cloudflare.worker")!).toMatchObject({ status: "error" });
    expect(byId(checks, "domain.routing:live.example.test")!.status).toBe("error");
    expect(byId(checks, "domain.worker_route:live.example.test")!.status).toBe("ok");
    // The development INGEST_SECRET is an error once real Cloudflare mail can reach the app.
    expect(byId(checks, "ingest_secret")!.status).toBe("error");

    t.deps.cf = new LiveCloudflareClient("token", "acc", cfApi({ "GET /user/tokens/verify": 401 }));
    const bad = await runDiagnostics(t.deps);
    expect(byId(bad.checks, "cloudflare.token")!.status).toBe("error");
    expect(byId(bad.checks, "cloudflare.token")!.hint).toContain("CF_API_TOKEN");
  });

  it("checks the single sign-on discovery document", async () => {
    const issuer = "https://auth.example.test";
    const env = { DATA_DIR: tmpDataDir(), OIDC_ISSUER: issuer, OIDC_CLIENT_SECRET: "secret-secret" };
    const ok = makeTestApp(env, {
      fetch: fakeFetch({ [`${issuer}/.well-known/openid-configuration`]: () => Response.json({ issuer }) }),
    });
    expect(byId((await runDiagnostics(ok.deps)).checks, "oidc.discovery")!.status).toBe("ok");
    const wrong = makeTestApp(env, {
      fetch: fakeFetch({ [`${issuer}/.well-known/openid-configuration`]: () => Response.json({ issuer: "https://other.example.test" }) }),
    });
    expect(byId((await runDiagnostics(wrong.deps)).checks, "oidc.discovery")!.detail).toContain("other.example.test");
    const down = makeTestApp(env, { fetch: fakeFetch({}) });
    expect(byId((await runDiagnostics(down.deps)).checks, "oidc.discovery")!.status).toBe("error");
  });

  it("tests IMAP domains, the local admin and backups", async () => {
    const dataDir = tmpDataDir();
    const fake = fakeMail();
    const t = makeTestApp(
      { DATA_DIR: dataDir, APP_SECRET: "s".repeat(40) },
      { mail: fake.clients, cf: new UnconfiguredCloudflareClient(), fetch: fakeFetch({}) },
    );
    let { checks } = await runDiagnostics(t.deps);
    expect(byId(checks, "local_login")!.status).toBe("warn"); // no admin yet
    expect(byId(checks, "cloudflare.token")!.status).toBe("ok"); // not needed without Cloudflare domains

    const admin = await setupAdmin(t);
    const r = await admin.post("/v1/domains", {
      name: "imap.example.test",
      transport: "imap",
      mailbox: { imap_host: "imap.provider.example", imap_user: "u@provider.example", imap_password: "imap-pass" },
    });
    expect(r.status).toBe(201);
    fs.mkdirSync(path.join(dataDir, "backups"));
    fs.writeFileSync(path.join(dataDir, "backups", "throwaway-20260101-031500.db.gz"), "x");

    ({ checks } = await runDiagnostics(t.deps));
    expect(byId(checks, "local_login")!.status).toBe("ok");
    expect(byId(checks, "app_secret")!.status).toBe("ok");
    expect(byId(checks, "domain.mailbox:imap.example.test")!.status).toBe("ok");
    expect(byId(checks, "backups")!.status).toBe("ok");
    expect(byId(checks, "domain.mx:imap.example.test")).toBeUndefined();

    fake.imap.password = "changed";
    ({ checks } = await runDiagnostics(t.deps));
    expect(byId(checks, "domain.mailbox:imap.example.test")!.status).toBe("error");
  });
});
