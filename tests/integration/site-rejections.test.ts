import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { siteKeys } from "../../app/server/services/sites.js";

async function setup() {
  let now = Date.now();
  const t = makeTestApp({}, { now: () => now });
  const admin = await setupAdmin(t);
  await addDomain(admin, "a.example.test");
  await addDomain(admin, "b.example.test");
  await addDomain(admin, "c.example.test");
  const user = loginAs(t, "u@example.org");
  return { t, admin, user, advance: (ms: number) => (now += ms) };
}

describe("sites rejecting alias domains", () => {
  it("normalises site keys", () => {
    expect(siteKeys("Shop", "https://www.shop.com/signup")).toEqual(["shop.com", "shop"]);
    expect(siteKeys("Shop", null)).toEqual(["shop"]);
  });

  it("records a rejection, replaces the address on another domain and remembers it for the site", async () => {
    const { t, user, admin } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "Shop", site_url: "shop.com" })).json.address;
    expect(a.domain).toBe("a.example.test");

    const r = await user.post(`/v1/addresses/${a.id}/rejected`, {});
    expect(r.status).toBe(201);
    expect(r.json.address.domain).not.toBe("a.example.test");
    expect(r.json.address.site_name).toBe("Shop");
    const old = (await user.get(`/v1/addresses/${a.id}`)).json.address;
    expect(old.status).toBe("paused");
    expect(old.site_rejected).toBe(true);

    // Per-site memory: same host, another user too; explicit preferred domain is skipped as well.
    const other = loginAs(t, "v@example.org");
    const n = await other.post("/v1/addresses", {
      site_name: "www.shop.com",
      site_url: "https://www.shop.com",
      preferred_domain: "a.example.test",
    });
    expect(n.json.address.domain).toBe("b.example.test");
    expect(n.json.avoided_domains).toEqual(["a.example.test"]);
    expect((await user.get("/v1/sites/domain?site_name=Shop&site_url=shop.com")).json).toEqual({
      domain: "b.example.test",
      avoided: ["a.example.test"],
    });
    // A forced domain is kept.
    expect((await user.post("/v1/addresses", { site_name: "Shop", domain: "a.example.test" })).json.address.domain).toBe("a.example.test");

    const list = (await user.get("/v1/site-rejections")).json.rejections;
    expect(list).toMatchObject([{ site: "shop.com", domain: "a.example.test" }]);
    const stats = (await admin.get("/v1/admin/site-rejections")).json.rejections;
    expect(stats).toMatchObject([{ site: "shop.com", domain: "a.example.test", reports: 1 }]);
    expect((await user.get("/v1/admin/site-rejections")).status).toBe(403);

    expect((await user.del(`/v1/site-rejections/${list[0].id}`)).status).toBe(200);
    expect((await user.get("/v1/sites/domain?site_name=Shop&site_url=shop.com")).json.domain).toBe("a.example.test");
  });

  it("rotates or randomises domains per user preference", async () => {
    const { user } = await setup();
    expect((await user.patch("/v1/auth/me/preferences", { domain_choice: "rotate" })).json.user.domain_choice).toBe("rotate");
    const got: string[] = [];
    for (let i = 0; i < 4; i++) got.push((await user.post("/v1/addresses", { site_name: `s${i}` })).json.address.domain);
    expect(got).toEqual(["a.example.test", "b.example.test", "c.example.test", "a.example.test"]);
    await user.patch("/v1/auth/me/preferences", { domain_choice: "random" });
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add((await user.post("/v1/addresses", { site_name: `r${i}` })).json.address.domain);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("flags addresses that received nothing after N minutes", async () => {
    const { t, user, advance } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "Quiet" })).json.address;
    const b = (await user.post("/v1/addresses", { site_name: "Loud" })).json.address;
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.no_mail_warning).toBe(false);
    await ingest(t, b.email, simpleEml({ text: "hi" }));
    advance(16 * 60_000);
    const list = (await user.get("/v1/addresses")).json.addresses;
    expect(list.find((x: any) => x.id === a.id).no_mail_warning).toBe(true);
    expect(list.find((x: any) => x.id === b.id).no_mail_warning).toBe(false);
    await user.patch("/v1/auth/me/preferences", { no_mail_warn_minutes: 0 });
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.no_mail_warning).toBe(false);
    advance(25 * 3600_000);
    await user.patch("/v1/auth/me/preferences", { no_mail_warn_minutes: 15 });
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.no_mail_warning).toBe(false);
  });

  it("refuses to replace when there is no other domain", async () => {
    const t = makeTestApp();
    const admin = await setupAdmin(t);
    await addDomain(admin, "only.example.test");
    const a = (await admin.post("/v1/addresses", { site_name: "X" })).json.address;
    expect((await admin.post(`/v1/addresses/${a.id}/rejected`, {})).status).toBe(400);
    const r = await admin.post(`/v1/addresses/${a.id}/rejected`, { replace: false });
    expect(r.json).toMatchObject({ address: null, other_domains: 0 });
  });
});
