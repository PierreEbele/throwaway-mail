import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  const mk = async (site: string, extra: Record<string, unknown> = {}) =>
    (await user.post("/v1/addresses", { site_name: site, ...extra })).json.address;
  return { t, admin, user, mk };
}

describe("categories and pins", () => {
  it("creates, lists (pinned first), assigns and deletes categories", async () => {
    const { user, mk } = await setup();
    const shop = (await user.post("/v1/categories", { name: "Shopping", color: "amber" })).json.category;
    const work = (await user.post("/v1/categories", { name: "Travail", pinned: true })).json.category;
    expect((await user.post("/v1/categories", { name: "Shopping" })).status).toBe(409);
    expect((await user.post("/v1/categories", { name: "x", color: "rainbow" })).status).toBe(400);

    const a = await mk("Amazon", { category_id: shop.id });
    expect(a.category_id).toBe(shop.id);
    await mk("Nowhere");

    const cats = (await user.get("/v1/categories")).json.categories;
    expect(cats.map((c: any) => c.name)).toEqual(["Travail", "Shopping"]);
    expect(cats.find((c: any) => c.id === shop.id).address_count).toBe(1);

    expect((await user.get(`/v1/addresses?category=${shop.id}`)).json.addresses.map((x: any) => x.site_name)).toEqual(["Amazon"]);
    expect((await user.get("/v1/addresses?category=none")).json.addresses.map((x: any) => x.site_name)).toEqual(["Nowhere"]);

    expect((await user.patch(`/v1/categories/${work.id}`, { name: "Boulot", pinned: false })).json.category).toMatchObject({
      name: "Boulot",
      pinned: false,
    });
    expect((await user.del(`/v1/categories/${shop.id}`)).status).toBe(200);
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.category_id).toBeNull();
  });

  it("keeps categories private and rejects foreign category ids", async () => {
    const { t, user, mk } = await setup();
    const other = loginAs(t, "other@example.org");
    const cat = (await other.post("/v1/categories", { name: "Mine" })).json.category;
    expect((await user.get("/v1/categories")).json.categories).toEqual([]);
    expect((await user.patch(`/v1/categories/${cat.id}`, { name: "Hacked" })).status).toBe(404);
    const a = await mk("Site");
    expect((await user.patch(`/v1/addresses/${a.id}`, { category_id: cat.id })).status).toBe(400);
  });

  it("hides addresses of hidden categories from the inbox only", async () => {
    const { user, mk } = await setup();
    const cat = (await user.post("/v1/categories", { name: "Noise" })).json.category;
    expect(cat.hidden).toBe(false);
    const a = await mk("Spammy");
    await mk("Loose");
    await user.patch(`/v1/addresses/${a.id}`, { category_id: cat.id });
    expect((await user.patch(`/v1/categories/${cat.id}`, { hidden: true })).json.category.hidden).toBe(true);
    expect((await user.get("/v1/addresses?hide_hidden=true")).json.addresses.map((x: any) => x.site_name)).toEqual(["Loose"]);
    expect((await user.get("/v1/addresses")).json.addresses).toHaveLength(2);
    expect((await user.get(`/v1/addresses?category=${cat.id}&hide_hidden=false`)).json.addresses).toHaveLength(1);
  });

  it("lists pinned addresses first", async () => {
    const { user, mk } = await setup();
    const first = await mk("Old");
    await mk("New");
    expect((await user.patch(`/v1/addresses/${first.id}`, { pinned: true })).json.address.pinned).toBe(true);
    expect((await user.get("/v1/addresses")).json.addresses.map((x: any) => x.site_name)).toEqual(["Old", "New"]);
    expect((await user.get("/v1/addresses?pinned=true")).json.addresses).toHaveLength(1);
  });
});

describe("addresses that never received mail", () => {
  it("suggests old silent addresses, then archives, deletes or keeps them", async () => {
    const { t, user, mk } = await setup();
    const day = 86400_000;
    const real = t.deps.now;
    let now = Date.now() - 31 * day;
    t.deps.now = () => now;
    const silent1 = await mk("Silent 1");
    const silent2 = await mk("Silent 2");
    const silent3 = await mk("Silent 3");
    const pinned = await mk("Pinned");
    await user.patch(`/v1/addresses/${pinned.id}`, { pinned: true });
    const used = await mk("Used");
    expect((await ingest(t, used.email, simpleEml({ text: "hello" }), { timestamp: Math.floor(now / 1000) })).status).toBeLessThan(300);
    expect((await user.get("/v1/stale-addresses?days=30")).json.addresses).toEqual([]);

    t.deps.now = real; // 31 days later
    const stale = (await user.get("/v1/stale-addresses?days=30")).json.addresses.map((x: any) => x.site_name);
    expect(stale.sort()).toEqual(["Silent 1", "Silent 2", "Silent 3"]);

    expect((await user.post("/v1/stale-addresses", { action: "archive", ids: [silent1.id, used.id] })).json).toEqual({
      affected: 1,
      skipped: 1,
    });
    expect((await user.get(`/v1/addresses/${silent1.id}`)).json.address.status).toBe("archived");
    expect((await user.post("/v1/stale-addresses", { action: "delete", ids: [silent2.id] })).json.affected).toBe(1);
    expect((await user.get(`/v1/addresses/${silent2.id}`)).status).toBe(404);
    expect((await user.post("/v1/stale-addresses", { action: "keep", ids: [silent3.id] })).json.affected).toBe(1);
    expect((await user.get("/v1/stale-addresses?days=30")).json.addresses).toEqual([]);
  });
});

describe("category by name", () => {
  it("assigns an existing category by name, or creates it on request", async () => {
    const { user, mk } = await setup();
    const shop = (await user.post("/v1/categories", { name: "Shopping" })).json.category;
    expect((await mk("A", { category: "shopping" })).category_id).toBe(shop.id);
    expect((await user.post("/v1/addresses", { site_name: "B", category: "Games" })).status).toBe(400);
    const b = await mk("B", { category: "Games", create_category: true });
    const games = (await user.get("/v1/categories")).json.categories.find((c: any) => c.name === "Games");
    expect(b.category_id).toBe(games.id);
    expect((await user.post("/v1/addresses", { site_name: "C", category: "Games", category_id: shop.id })).status).toBe(400);
    expect((await user.patch(`/v1/addresses/${b.id}`, { category: "Shopping" })).json.address.category_id).toBe(shop.id);
  });
});
