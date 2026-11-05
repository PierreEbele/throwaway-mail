import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { messages } from "../../app/server/db/schema.js";

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  t.deps.fetch = (async () => new Response("ok")) as typeof fetch;
  const a = (await user.post("/v1/addresses", { site_name: "Git & Hub" })).json.address;
  return { t, user, a };
}

const get = (t: ReturnType<typeof makeTestApp>, path: string) => t.app.request(path);

describe("address feeds", () => {
  it("is off by default and unknown or malformed tokens are not found", async () => {
    const { t, a } = await setup();
    expect(a.feed_token).toBeNull();
    expect((await get(t, `/feeds/${"a".repeat(32)}.rss`)).status).toBe(404);
    expect((await get(t, "/feeds/short.json")).status).toBe(404);
    expect((await get(t, `/feeds/${"a".repeat(32)}.xml`)).status).toBe(404);
  });

  it("serves RSS and JSON with codes, escapes content, and can be rotated or turned off", async () => {
    const { t, user, a } = await setup();
    const other = loginAs(t, "other@example.org");
    expect((await other.post(`/v1/addresses/${a.id}/feed`, { enabled: true })).status).toBe(404);

    const on = await user.post(`/v1/addresses/${a.id}/feed`, { enabled: true });
    expect(on.status).toBe(200);
    const token = on.json.address.feed_token as string;
    expect(token).toMatch(/^[a-z0-9]{32}$/);

    await ingest(t, a.email, simpleEml({ subject: "Your code", text: "Your verification code is 482913" }));
    await ingest(t, a.email, simpleEml({ subject: "<b>Tom & Jerry</b>", text: "Hello <world>", from: "Shop <shop@example.com>" }));

    const rss = await get(t, `/feeds/${token}.rss`);
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toContain("application/rss+xml");
    expect(rss.headers.get("x-robots-tag")).toBe("noindex");
    expect(rss.headers.get("cache-control")).toContain("private");
    const xml = await rss.text();
    expect(xml).toContain("<title>Git &amp; Hub — " + a.email + "</title>");
    expect(xml).toContain("[482913] Your code");
    expect(xml).toContain("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
    expect(xml).toContain("Hello &lt;world&gt;");
    expect(xml).not.toContain("<b>");
    expect(xml.match(/<item>/g)).toHaveLength(2);

    const json = await get(t, `/feeds/${token}.json`);
    const feed = (await json.json()) as any;
    expect(feed.version).toBe("https://jsonfeed.org/version/1.1");
    expect(feed.items).toHaveLength(2);
    // Newest first.
    expect(feed.items[0].title).toBe("<b>Tom & Jerry</b>");
    const coded = feed.items.find((i: any) => i._throwaway.code === "482913");
    expect(coded).toMatchObject({ title: "[482913] Your code", url: `http://localhost:3000/addresses/${a.id}` });
    expect(new Date(coded.date_published).getTime()).toBeGreaterThan(0);

    // Rotating invalidates the old URL.
    const rotated = (await user.post(`/v1/addresses/${a.id}/feed`, { enabled: true })).json.address.feed_token;
    expect(rotated).not.toBe(token);
    expect((await get(t, `/feeds/${token}.rss`)).status).toBe(404);
    expect((await get(t, `/feeds/${rotated}.json`)).status).toBe(200);

    expect((await user.post(`/v1/addresses/${a.id}/feed`, { enabled: false })).json.address.feed_token).toBeNull();
    expect((await get(t, `/feeds/${rotated}.json`)).status).toBe(404);
  });

  it("leaves archived messages out", async () => {
    const { t, user, a } = await setup();
    const token = (await user.post(`/v1/addresses/${a.id}/feed`, { enabled: true })).json.address.feed_token;
    await ingest(t, a.email, simpleEml({ subject: "keep", text: "1" }));
    await ingest(t, a.email, simpleEml({ subject: "archive me", text: "2" }));
    t.deps.db.update(messages).set({ archivedAt: Date.now() }).where(eq(messages.subject, "archive me")).run();
    const feed = (await (await get(t, `/feeds/${token}.json`)).json()) as any;
    expect(feed.items.map((i: any) => i.title)).toEqual(["keep"]);
  });
});
