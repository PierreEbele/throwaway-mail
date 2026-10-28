import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";

describe("admin health and metrics", () => {
  it("reports domains, counts and ingest counters; admin only", async () => {
    const t = makeTestApp();
    const admin = await setupAdmin(t);
    await addDomain(admin, "mail.example.test");
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json.address;
    await ingest(t, a.email, simpleEml({ text: "x" }));
    await ingest(t, "nobody@mail.example.test", simpleEml({ text: "x" }));
    const h = (await admin.get("/v1/admin/health")).json;
    expect(h.counts).toMatchObject({ addresses: 1, messages: 1, messages_24h: 1 });
    expect(h.domains[0].name).toBe("mail.example.test");
    expect(h.domains[0].last_ingest_at).toBeGreaterThan(0);
    expect(h.ingest).toEqual(expect.arrayContaining([expect.objectContaining({ action: "reject", reason: "unknown_recipient" })]));
    expect((await loginAs(t, "u@example.org").get("/v1/admin/health")).status).toBe(403);
  });

  it("/metrics needs METRICS_TOKEN", async () => {
    const off = makeTestApp();
    expect((await off.app.request("/metrics")).status).toBe(404);
    const t = makeTestApp({ METRICS_TOKEN: "metrics-token-0123456789" });
    expect((await t.app.request("/metrics")).status).toBe(401);
    const res = await t.app.request("/metrics", { headers: { authorization: "Bearer metrics-token-0123456789" } });
    const body = await res.text();
    expect(body).toContain("# TYPE throwaway_ingest_total counter");
    expect(body).toMatch(/throwaway_rows\{kind="addresses"\} \d+/);
  });
});
