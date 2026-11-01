import { describe, expect, it } from "vitest";
import { LiveCloudflareClient, CloudflareError } from "../../app/server/cloudflare/index.js";

type Handler = (method: string, path: string, body: any) => { status?: number; result?: unknown; errors?: unknown[] } | undefined;

function fakeApi(handler: Handler) {
  const calls: Array<{ method: string; path: string; body: any; auth: string | null }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace("/client/v4", "") + u.search;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method!, path, body, auth: new Headers(init.headers).get("authorization") });
    const r = handler(init.method!, path, body) ?? { status: 404, errors: [{ code: 1000, message: "not found" }] };
    const ok = (r.status ?? 200) < 400;
    return Response.json({ success: ok, errors: r.errors ?? [], result: r.result ?? null }, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("live Cloudflare client", () => {
  it("finds parent zones, enables routing, sets the catch-all to the Worker", async () => {
    const { f, calls } = fakeApi((m, p) => {
      if (p === "/zones?name=mail.example.com") return { result: [] };
      if (p === "/zones?name=example.com") return { result: [{ id: "z1", name: "example.com", status: "active" }] };
      if (p === "/zones/z1/email/routing" && m === "GET") return { result: { enabled: false } };
      if (p === "/zones/z1/email/routing/dns" && m === "POST") return { result: {} };
      if (p === "/zones/z1/email/routing/rules/catch_all" && m === "PUT") return { result: {} };
    });
    const cf = new LiveCloudflareClient("tok", "acct", f);
    const zone = await cf.findZone("mail.example.com");
    expect(zone?.id).toBe("z1");
    await cf.enableEmailRouting("z1", "mail.example.com");
    await cf.setCatchAllToWorker("z1", "throwaway-mail-ingest");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: ["throwaway-mail-ingest"] }],
    });
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("reads the current catch-all and can put a previous one back", async () => {
    const { f, calls } = fakeApi((m, p) => {
      if (p === "/zones/z1/email/routing/rules/catch_all" && m === "GET")
        return { result: { enabled: true, actions: [{ type: "forward", value: ["me@x.com"] }], matchers: [{ type: "all" }] } };
      if (p === "/zones/z1/email/routing/rules/catch_all" && m === "PUT") return { result: {} };
    });
    const cf = new LiveCloudflareClient("t", "a", f);
    const rule = await cf.getCatchAll("z1");
    expect(rule).toEqual({ enabled: true, actions: [{ type: "forward", value: ["me@x.com"] }] });
    await cf.setCatchAll("z1", rule!);
    expect(calls.at(-1)!.body).toMatchObject({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: ["me@x.com"] }],
    });
  });

  it("reports missing DNS records in both API shapes", async () => {
    const newShape = fakeApi(() => ({
      result: {
        errors: [{ code: "mx.missing", missing: { type: "MX", name: "a.com", content: "route1.mx.cloudflare.net", priority: 1 } }],
        record: [],
      },
    }));
    expect(await new LiveCloudflareClient("t", "a", newShape.f).missingDnsRecords("z", "a.com", "a.com")).toHaveLength(1);
    // Older shape, as returned for example.dev: MX + SPF on the apex, DKIM on its own name
    const existing: Record<string, unknown[]> = {
      "MX a.com": [{ type: "MX", name: "a.com", content: "route1.mx.cloudflare.net" }],
      // stored split in two quoted chunks, as Cloudflare does for long DKIM keys
      "TXT cf2024-1._domainkey.a.com": [{ type: "TXT", name: "cf2024-1._domainkey.a.com", content: '"v=DKIM1; p=ab" "c"' }],
      "TXT a.com": [],
    };
    const oldShape = fakeApi((_m, p) => {
      if (p.startsWith("/zones/z/email/routing/dns"))
        return {
          result: [
            { type: "MX", name: "a.com", content: "route1.mx.cloudflare.net." },
            { type: "TXT", name: "cf2024-1._domainkey.a.com", content: '"v=DKIM1; p=abc"' },
            { type: "TXT", name: "a.com", content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
          ],
        };
      if (p.startsWith("/zones/z/dns_records")) {
        const q = new URLSearchParams(p.split("?")[1]);
        return { result: existing[`${q.get("type")} ${q.get("name")}`] ?? [] };
      }
    });
    const missing = await new LiveCloudflareClient("t", "a", oldShape.f).missingDnsRecords("z", "a.com", "a.com");
    expect(missing.map((r) => `${r.type} ${r.name}`)).toEqual(["TXT a.com"]);
    expect(oldShape.calls[0]!.path).toBe("/zones/z/email/routing/dns"); // no subdomain parameter for the apex
  });

  it("passes the subdomain parameter only for a real sub-domain", async () => {
    const { f, calls } = fakeApi(() => ({ result: { errors: [], record: [] } }));
    await new LiveCloudflareClient("t", "a", f).missingDnsRecords("z", "mail.a.com", "a.com");
    expect(calls[0]!.path).toBe("/zones/z/email/routing/dns?subdomain=mail.a.com");
  });

  it("reuses an existing account-level destination", async () => {
    const { f } = fakeApi((m, p) => {
      if (m === "POST") return { status: 400, errors: [{ code: 2032, message: "Destination address already exists" }] };
      if (p.startsWith("/accounts/acct/email/routing/addresses?"))
        return { result: [{ id: "d1", email: "me@x.com", verified: "2024-01-01T00:00:00Z" }] };
    });
    const d = await new LiveCloudflareClient("t", "acct", f).createDestination("me@x.com");
    expect(d).toEqual({ id: "d1", email: "me@x.com", verified: "2024-01-01T00:00:00Z" });
  });

  it("surfaces readable API errors without leaking the account id", async () => {
    const { f } = fakeApi(() => ({ status: 403, errors: [{ code: 10000, message: "Authentication error" }] }));
    const err = await new LiveCloudflareClient("t", "secret-acct", f).createDestination("x@y.com").catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect(err.message).toContain("Authentication error (code 10000)");
    expect(err.message).not.toContain("secret-acct");
  });
});
