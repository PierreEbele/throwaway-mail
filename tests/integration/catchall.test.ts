import { beforeEach, describe, expect, it } from "vitest";
import { Client, addDomain, ingest, makeTestApp, setupAdmin, simpleEml, type TestApp } from "../helpers.js";
import { suggestSite } from "../../app/server/routes/review.js";

let t: TestApp;
let admin: Client;
const DOMAIN = "catchall.example.test"; // the mock gives this zone an existing catch-all → me@personal.example

beforeEach(async () => {
  t = makeTestApp();
  admin = await setupAdmin(t);
});

const zoneOf = (d: any) => t.cf.zones.get(d.cf_zone_id)!;

describe("existing catch-all is preserved", () => {
  it("takes over the catch-all but keeps forwarding unknown addresses to the old destination", async () => {
    const dom = await addDomain(admin, DOMAIN);
    expect(dom.status).toBe("active");
    expect(dom.catchall_forward_to).toBe("me@personal.example");
    expect(dom.previous_catch_all).toEqual({ enabled: true, actions: [{ type: "forward", value: ["me@personal.example"] }] });
    expect(zoneOf(dom).catchAllWorker).toBe("throwaway-mail-ingest");

    const r = await ingest(t, `shop123@${DOMAIN}`, simpleEml({ text: "Welcome", from: "Shop <news@mail.shop.example>" }), { from: "bounce@mail.shop.example" });
    expect(r.json).toMatchObject({ action: "forward", forward_to: "me@personal.example" });
    // re-checking the domain later does not lose the remembered rule
    const again = (await admin.post(`/v1/domains/${dom.id}/verify`)).json.domain;
    expect(again.catchall_forward_to).toBe("me@personal.example");
  });

  it("lists caught mail for review and registers it as a site, keeping the forwarding", async () => {
    await addDomain(admin, DOMAIN);
    await ingest(t, `shop123@${DOMAIN}`, simpleEml({ subject: "Order", text: "a", from: "Shop <news@mail.shop.example>" }));
    await ingest(t, `Shop123+promo@${DOMAIN}`, simpleEml({ subject: "Promo", text: "b", from: "Shop <news@mail.shop.example>" }));
    await ingest(t, `forum@${DOMAIN}`, simpleEml({ text: "c", from: "Forum <noreply@forum.example>" }));
    const review = (await admin.get("/v1/review")).json;
    expect(review.total).toBe(2);
    const shop = review.items.find((i: any) => i.recipient === `shop123@${DOMAIN}`);
    expect(shop).toMatchObject({ count: 2, forwarded_to: "me@personal.example", suggestion: { siteName: "Shop", siteUrl: "https://shop.example" }, registrable: true });
    expect((await admin.get("/v1/review/count")).json.count).toBe(2);

    const reg = await admin.post("/v1/review/register", { recipient: `shop123@${DOMAIN}`, site_name: "Shop", site_url: "shop.example" });
    expect(reg.status).toBe(201);
    expect(reg.json.address).toMatchObject({ email: `shop123@${DOMAIN}`, site_url: "https://shop.example", forward_enabled: true });
    expect((await admin.get(`/v1/addresses/${reg.json.address.id}/messages`)).json.messages).toHaveLength(2);
    const dests = (await admin.get("/v1/destinations")).json.destinations;
    expect(dests).toMatchObject([{ email: "me@personal.example", verified: true }]);
    // next mail goes through the registered address, still forwarded
    expect((await ingest(t, `shop123@${DOMAIN}`, simpleEml({ text: "d" }))).json).toMatchObject({ action: "forward", forward_to: "me@personal.example" });
    expect((await admin.get("/v1/review")).json.items.map((i: any) => i.recipient)).toEqual([`forum@${DOMAIN}`]);
  });

  it("blocks and dismisses caught recipients", async () => {
    await addDomain(admin, DOMAIN);
    await ingest(t, `spam@${DOMAIN}`, simpleEml({ text: "x" }));
    await ingest(t, `old@${DOMAIN}`, simpleEml({ text: "y" }));
    expect((await admin.post("/v1/review/register", { recipient: `spam@${DOMAIN}`, site_name: "Spammer", block: true })).json.address.status).toBe("paused");
    expect((await ingest(t, `spam@${DOMAIN}`, simpleEml({ text: "x2" }))).json.action).toBe("reject");
    expect((await admin.post("/v1/review/dismiss", { recipient: `old@${DOMAIN}` })).json.deleted).toBe(1);
    expect((await admin.get("/v1/review")).json.items).toEqual([]);
    // dismissed recipients still follow the old catch-all
    expect((await ingest(t, `old@${DOMAIN}`, simpleEml({ text: "y2" }))).json.action).toBe("forward");
  });

  it("can stop forwarding unknown addresses, then the domain policy applies", async () => {
    const dom = await addDomain(admin, DOMAIN);
    await admin.patch(`/v1/domains/${dom.id}`, { forward_unknown: false });
    expect((await ingest(t, `nobody@${DOMAIN}`, simpleEml({ text: "x" }))).json.reason).toBe("unknown_recipient");
    await admin.patch(`/v1/domains/${dom.id}`, { forward_unknown: true });
    expect((await ingest(t, `nobody@${DOMAIN}`, simpleEml({ text: "x" }))).json.action).toBe("forward");
  });

  it("restores the old catch-all when the domain is removed", async () => {
    const dom = await addDomain(admin, DOMAIN);
    await ingest(t, `nobody@${DOMAIN}`, simpleEml({ text: "x" })); // creates the review box, which must not block removal
    const res = await admin.del(`/v1/domains/${dom.id}`);
    expect(res.json).toEqual({ ok: true, catch_all_restored: true });
    expect(zoneOf(dom).catchAll).toEqual({ enabled: true, actions: [{ type: "forward", value: ["me@personal.example"] }] });
  });

  it("never overwrites a catch-all that sends to another Worker", async () => {
    const zoneId = "mockzone_other_example_test";
    t.cf.zones.set(zoneId, { routing: true, catchAll: { enabled: true, actions: [{ type: "worker", value: ["someone-elses-worker"] }] } });
    const dom = (await admin.post("/v1/domains", { name: "other.example.test" })).json.domain;
    expect(dom.status).toBe("error");
    expect(dom.status_detail).toMatch(/another Worker/);
    expect(t.cf.zones.get(zoneId)!.catchAll!.actions[0]!.value).toEqual(["someone-elses-worker"]);
  });

  it("other users cannot see or register an admin's review items", async () => {
    await addDomain(admin, DOMAIN);
    await ingest(t, `x@${DOMAIN}`, simpleEml({ text: "x" }));
    const { loginAs } = await import("../helpers.js");
    const u = loginAs(t, "u@example.org");
    expect((await u.get("/v1/review")).json.items).toEqual([]);
    expect((await u.post("/v1/review/register", { recipient: `x@${DOMAIN}`, site_name: "X" })).status).toBe(404);
    expect((await u.post("/v1/review/dismiss", { recipient: `x@${DOMAIN}` })).status).toBe(404);
  });
});

describe("site suggestion", () => {
  it("derives a site from the sender domain", () => {
    expect(suggestSite("mail.github.com")).toEqual({ siteName: "Github", siteUrl: "https://github.com" });
    expect(suggestSite("email.notifications.amazon.co.uk")).toEqual({ siteName: "Amazon", siteUrl: "https://amazon.co.uk" });
    expect(suggestSite("leboncoin.fr")).toEqual({ siteName: "Leboncoin", siteUrl: "https://leboncoin.fr" });
    expect(suggestSite(null)).toEqual({ siteName: "", siteUrl: null });
  });
});
