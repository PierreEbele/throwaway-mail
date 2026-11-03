import { describe, expect, it } from "vitest";
import { ThrowawayMailError } from "../../sdk/src/index.js";
import { ingest, simpleEml } from "../helpers.js";
import { DOMAIN, sdkFixture } from "./setup.js";

describe("SDK: addresses", () => {
  it("creates an address straight into a new category by name", async () => {
    const { tm, calls } = await sdkFixture();
    const a = await tm.addresses.create({ site: "github.com", category: "Dev", createCategory: true });
    expect(a.email.endsWith(`@${DOMAIN}`)).toBe(true);
    expect(a.site_name).toBe("github.com");
    const cats = await tm.categories.list();
    expect(cats.map((c) => c.name)).toEqual(["Dev"]);
    expect(a.category_id).toBe(cats[0]!.id);
    // An existing name is matched case-insensitively and no duplicate is created.
    const b = await tm.addresses.create({ siteName: "GitLab", category: "dev" });
    expect(b.category_id).toBe(cats[0]!.id);
    expect(await tm.categories.list()).toHaveLength(1);
    expect(calls[0]).toBe("POST /v1/addresses");
  });

  it("maps list filters to snake_case query parameters", async () => {
    const { t, tm, calls } = await sdkFixture();
    const a = await tm.addresses.create({ siteName: "Shop", localPart: "shop1" });
    const b = await tm.addresses.create({ siteName: "Forum", localPart: "forum1" });
    await tm.addresses.update(b.id, { pinned: true });
    expect(await ingest(t, a.email, simpleEml({ subject: "Your code", text: "Your verification code is 482913" }))).toMatchObject({
      status: 200,
    });

    expect((await tm.addresses.list({ pinned: true })).map((x) => x.id)).toEqual([b.id]);
    expect((await tm.addresses.list({ hasCode: true, unread: true, sinceHours: 1 })).map((x) => x.id)).toEqual([a.id]);
    expect((await tm.addresses.list({ q: "forum" })).map((x) => x.id)).toEqual([b.id]);
    expect(await tm.addresses.list({ domain: "nope.example" })).toEqual([]);
    expect(calls).toContain("GET /v1/addresses?unread=true&has_code=true&since_hours=1");
  });

  it("waitForCode resolves once mail arrives during the long-poll", async () => {
    const { t, tm } = await sdkFixture();
    const a = await tm.addresses.create({ siteName: "Bank", localPart: "bank1" });
    const since = Date.now() - 1;
    const pending = tm.addresses.waitForCode(a.id, { timeoutMs: 10_000, since, require: "code" });
    await new Promise((r) => setTimeout(r, 100));
    await ingest(t, a.email, simpleEml({ subject: "Login code", text: "Your one-time code is 739104" }));
    const r = await pending;
    expect(r.code).toBe("739104");
    expect(r.message_id).toMatch(/^msg_/);

    // Mail older than `since` is ignored; the overall timeout is honoured.
    const err = await tm.addresses.waitForCode(a.id, { timeoutMs: 1200, since: r.message_id }).catch((e) => e);
    expect(err).toBeInstanceOf(ThrowawayMailError);
    expect(err.code).toBe("timeout");
    expect(await tm.addresses.getCode(a.id)).toMatchObject({ code: "739104" });
  });

  it("maps API errors to ThrowawayMailError", async () => {
    const { tm } = await sdkFixture();
    const nf = await tm.addresses.get("adr_missing").catch((e) => e);
    expect(nf).toBeInstanceOf(ThrowawayMailError);
    expect(nf).toMatchObject({ status: 404, code: "not_found" });

    const bad = await tm.addresses.create({ siteName: "X", category: "Nope" }).catch((e) => e);
    expect(bad).toMatchObject({ status: 400, code: "bad_request" });
    expect(bad.message).toMatch(/Unknown category/);

    const invalid = await tm.addresses.list({ sinceHours: 0 }).catch((e) => e);
    expect(invalid).toMatchObject({ status: 400, code: "bad_request" });
    expect(Array.isArray(invalid.details)).toBe(true);
  });

  it("bulk-moves addresses between categories", async () => {
    const { tm } = await sdkFixture();
    const cat = await tm.categories.create({ name: "Shopping", color: "green" });
    const a = await tm.addresses.create({ siteName: "A" });
    const b = await tm.addresses.create({ siteName: "B" });
    expect(await tm.addresses.move([a.id, b.id], cat.id)).toBe(2);
    expect((await tm.addresses.list({ category: cat.id })).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(await tm.addresses.move([a.id], null)).toBe(1);
    expect((await tm.addresses.list({ category: "none" })).map((x) => x.id)).toEqual([a.id]);
  });

  it("lists, reads and bulk-archives messages", async () => {
    const { t, tm } = await sdkFixture();
    const a = await tm.addresses.create({ siteName: "News", localPart: "news1" });
    await ingest(t, a.email, simpleEml({ subject: "One", text: "hello" }));
    await ingest(t, a.email, simpleEml({ subject: "Two", text: "world" }));
    const list = await tm.addresses.messages(a.id);
    expect(list.map((m) => m.subject).sort()).toEqual(["One", "Two"]);
    const full = await tm.messages.get(list[0]!.id);
    expect(full.text).toContain(list[0]!.subject === "One" ? "hello" : "world");
    await tm.messages.markRead(full.id);
    expect((await tm.messages.get(full.id)).read_at).not.toBeNull();
    expect(await tm.messages.bulk(a.id, "archive", { scope: "inbox" })).toBe(2);
    expect(await tm.addresses.messages(a.id)).toEqual([]);
    expect(await tm.addresses.messages(a.id, { archived: "all" })).toHaveLength(2);
  });
});
