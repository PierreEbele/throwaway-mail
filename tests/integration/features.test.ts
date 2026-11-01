import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { runRetention } from "../../app/server/services/retention.js";
import { baseDomain, looksLikeLeak } from "../../app/server/lib/senders.js";

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  const mk = async (site: string, extra: Record<string, unknown> = {}) =>
    (await user.post("/v1/addresses", { site_name: site, ...extra })).json.address;
  return { t, user, mk };
}

describe("sender helpers", () => {
  it("compares sender and site domains", () => {
    expect(baseDomain("mail.news.example.co.uk")).toBe("example.co.uk");
    expect(looksLikeLeak("https://www.shop.com", "news@mail.shop.com", [])).toBe(false);
    expect(looksLikeLeak("https://shop.com", "x@shop.fr", [])).toBe(false);
    expect(looksLikeLeak("https://shop.com", "x@casino.biz", [])).toBe(true);
    expect(looksLikeLeak("https://shop.com", "x@casino.biz", ["casino.biz"])).toBe(false);
    expect(looksLikeLeak(null, "x@casino.biz", [])).toBe(false);
  });
});

describe("extra features", () => {
  it("bulk-moves, reorders and auto-categorises", async () => {
    const { user, mk } = await setup();
    const shop = (await user.post("/v1/categories", { name: "Shopping", auto_match: "shop, store" })).json.category;
    const work = (await user.post("/v1/categories", { name: "Work" })).json.category;
    const auto = await mk("Big Store");
    expect(auto.category_id).toBe(shop.id);
    expect((await mk("Other", { category_id: null })).category_id).toBe(null);
    const a = await mk("A");
    const b = await mk("B");
    expect((await user.post("/v1/addresses/bulk", { ids: [a.id, b.id], action: "move", category_id: work.id })).json.affected).toBe(2);
    expect((await user.get(`/v1/addresses?category=${work.id}`)).json.addresses).toHaveLength(2);
    await user.post("/v1/addresses/bulk", { ids: [a.id], action: "archive" });
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.status).toBe("archived");
    await user.post("/v1/categories/reorder", { ids: [work.id, shop.id] });
    expect((await user.get("/v1/categories")).json.categories.map((c: any) => c.name)).toEqual(["Work", "Shopping"]);
  });

  it("flags leaks, blocks senders and counts unread per category", async () => {
    const { t, user, mk } = await setup();
    const cat = (await user.post("/v1/categories", { name: "Shops" })).json.category;
    const a = await mk("Shop", { site_url: "shop.com", category_id: cat.id });
    await ingest(t, a.email, simpleEml({ text: "hi", from: "Shop <news@shop.com>" }));
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.leak).toBe(null);
    await ingest(t, a.email, simpleEml({ text: "win", from: "Casino <promo@casino.biz>" }));
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.leak.sender).toBe("promo@casino.biz");
    expect((await user.get("/v1/categories")).json.categories[0].unread_count).toBe(2);
    expect((await user.get("/v1/digest")).json.leaks).toHaveLength(1);

    const blocked = (await user.post(`/v1/addresses/${a.id}/senders`, { action: "block" })).json.address;
    expect(blocked.blocked_senders).toEqual(["casino.biz"]);
    expect(blocked.leak).toBe(null);
    const res = await ingest(t, a.email, simpleEml({ text: "again", from: "promo@mail.casino.biz" }));
    expect(res.json.action).toBe("reject");

    expect((await user.get("/v1/addresses?q=win")).json.addresses.map((x: any) => x.id)).toEqual([a.id]);
    const stats = (await user.get(`/v1/addresses/${a.id}/stats`)).json;
    expect(stats.total).toBe(2);
    expect(stats.per_week[11]).toBe(2);
  });

  it("applies per-category retention", async () => {
    const { t, user, mk } = await setup();
    const cat = (await user.post("/v1/categories", { name: "Short", retention_days: 1 })).json.category;
    const a = await mk("A", { category_id: cat.id });
    const b = await mk("B");
    await ingest(t, a.email, simpleEml({ text: "x" }));
    await ingest(t, b.email, simpleEml({ text: "y" }));
    const real = t.deps.now;
    t.deps.now = () => real() + 2 * 86400_000;
    runRetention(t.deps);
    t.deps.now = real;
    expect((await user.get(`/v1/addresses/${a.id}/messages`)).json.messages).toHaveLength(0);
    expect((await user.get(`/v1/addresses/${b.id}/messages`)).json.messages).toHaveLength(1);
  });

  it("exports and re-imports addresses", async () => {
    const { t, user, mk } = await setup();
    await user.post("/v1/categories", { name: "Keep", color: "red" });
    const cat = (await user.get("/v1/categories")).json.categories[0];
    await mk("Site", { category_id: cat.id, local_part: "hello" });
    const dump = (await user.get("/v1/export")).json;
    expect(dump.addresses[0]).toMatchObject({ email: "hello@mail.example.test", category: "Keep" });

    const other = loginAs(t, "v@example.org");
    const again = (await other.post("/v1/import", dump)).json;
    expect(again.categories_created).toBe(1);
    expect(again.skipped).toEqual([{ email: "hello@mail.example.test", reason: "already exists" }]);
    dump.addresses[0].email = "fresh@mail.example.test";
    expect((await other.post("/v1/import", dump)).json.addresses_created).toBe(1);
    expect((await other.get("/v1/addresses")).json.addresses[0].category_id).toBeTruthy();
  });
});

describe("leak history, dedupe and attachments", () => {
  it("records every leak and blocks a sender everywhere", async () => {
    const { t, user, mk } = await setup();
    const a = await mk("A", { site_url: "a.com" });
    const b = await mk("B", { site_url: "b.com" });
    await ingest(t, a.email, simpleEml({ text: "1", from: "x@spam.biz" }));
    await ingest(t, b.email, simpleEml({ text: "2", from: "y@news.spam.biz" }));
    const leaks = (await user.get("/v1/leaks")).json.leaks;
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ sender_domain: "spam.biz", count: 2 });
    expect(leaks[0].addresses).toHaveLength(2);
    expect((await user.post("/v1/leaks/block", { sender_domain: "spam.biz" })).json.affected).toBe(2);
    expect((await user.get(`/v1/addresses/${b.id}`)).json.address.blocked_senders).toEqual(["spam.biz"]);
  });

  it("deduplicates retried mail without Message-ID and lists attachments", async () => {
    const { t, user, mk } = await setup();
    const a = await mk("A");
    const eml = [
      "From: x@a.com",
      "To: a@mail.example.test",
      "Subject: file",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--b",
      'Content-Type: application/pdf; name="bill.pdf"',
      'Content-Disposition: attachment; filename="bill.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--b--",
      "",
    ].join("\r\n");
    await ingest(t, a.email, eml);
    expect((await ingest(t, a.email, eml)).json.duplicate).toBe(true);
    const msgs = (await user.get(`/v1/addresses/${a.id}/messages`)).json.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].attachments).toEqual([{ filename: "bill.pdf", mime_type: "application/pdf", size: 9, inline: false }]);
  });
});
