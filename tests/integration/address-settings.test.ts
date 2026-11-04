import { describe, expect, it } from "vitest";
import { addDomain, loginAs, makeTestApp, setupAdmin } from "../helpers.js";
import { LOCAL_PART_RE } from "../../app/server/lib/email.js";
import { AddressSettings, generateLocalPart, siteSlug, templateProblem } from "../../app/server/services/alias-format.js";

const settings = (s: Partial<AddressSettings>) => AddressSettings.parse(s);

describe("local-part formats", () => {
  it("generates valid local parts in every format", () => {
    const cases: Array<[Partial<AddressSettings>, RegExp]> = [
      [{ format: "words" }, /^[a-z]+-[a-z]+-\d{4}$/],
      [{ format: "random", length: 8 }, /^[a-z][a-z0-9]{7}$/],
      [{ format: "random", length: 32 }, /^[a-z][a-z0-9]{31}$/],
      [{ format: "word.word" }, /^[a-z]+\.[a-z]+$/],
      [{ format: "template", template: "{word}-{rand6}" }, /^[a-z]+-[a-z0-9]{6}$/],
      [{ format: "template", template: "{site}.{digits8}" }, /^hackernews\.\d{8}$/],
    ];
    for (const [s, re] of cases)
      for (let i = 0; i < 50; i++) {
        const lp = generateLocalPart(settings(s), "Hacker News");
        expect(lp).toMatch(re);
        expect(LOCAL_PART_RE.test(lp)).toBe(true);
      }
    // word.word gets digits after a few collisions.
    expect(generateLocalPart(settings({ format: "word.word" }), "x", 6)).toMatch(/^[a-z]+\.[a-z]+\d+$/);
    expect(siteSlug("Ça va, Café!")).toBe("cavacafe");
  });

  it("rejects templates that are invalid or not random enough", () => {
    expect(templateProblem("{word}-{rand6}")).toBeNull();
    expect(templateProblem("{site}")).toMatch(/random enough/);
    expect(templateProblem("{word}")).toMatch(/random enough/);
    expect(templateProblem("{foo}-{rand8}")).toMatch(/Unknown placeholder/);
    expect(templateProblem("-{rand8}")).toMatch(/start and end/);
    expect(templateProblem("{rand0}{word}{word}{word}")).toMatch(/1 to 32/);
    expect(templateProblem("{rand32}{rand32}{rand32}")).toMatch(/64 characters/);
    expect(templateProblem("")).toMatch(/empty/);
  });
});

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  return { t, user: loginAs(t, "u@example.org") };
}

describe("new-address settings", () => {
  it("stores the format and applies it to new addresses, with examples", async () => {
    const { user } = await setup();
    const def = await user.get("/v1/settings/addresses");
    expect(def.json.settings).toEqual({
      format: "words",
      length: 12,
      template: null,
      default_expires_in_days: null,
      default_max_messages: null,
    });
    expect(def.json.examples).toHaveLength(3);

    expect((await user.req("PUT", "/v1/settings/addresses", { format: "template", template: "{site}" })).status).toBe(400);
    expect((await user.req("PUT", "/v1/settings/addresses", { format: "random", length: 4 })).status).toBe(400);
    const prev = await user.post("/v1/settings/addresses/preview", { format: "template", template: "tm-{rand8}" });
    expect(prev.json.examples[0]).toMatch(/^tm-[a-z0-9]{8}$/);

    const put = await user.req("PUT", "/v1/settings/addresses", { format: "template", template: "{site}-{rand6}" });
    expect(put.status).toBe(200);
    const a = (await user.post("/v1/addresses", { site_name: "GitHub" })).json.address;
    expect(a.email).toMatch(/^github-[a-z0-9]{6}@mail\.example\.test$/);
    // An explicit local part still wins.
    expect((await user.post("/v1/addresses", { site_name: "X", local_part: "chosen" })).json.email).toBe("chosen@mail.example.test");
  });

  it("finds a free address when the short format collides", async () => {
    const { user } = await setup();
    await user.req("PUT", "/v1/settings/addresses", { format: "word.word" });
    const emails = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = await user.post("/v1/addresses", { site_name: `s${i}` });
      expect(r.status).toBe(201);
      emails.add(r.json.email);
    }
    expect(emails.size).toBe(40);
  });

  it("applies the default expiry and max mails only when the creator does not say", async () => {
    const { t, user } = await setup();
    await user.req("PUT", "/v1/settings/addresses", { format: "words", default_expires_in_days: 30, default_max_messages: 5 });
    const now = t.deps.now();
    const a = (await user.post("/v1/addresses", { site_name: "A" })).json.address;
    expect(a.max_messages).toBe(5);
    expect(a.expires_at).toBeGreaterThanOrEqual(now + 30 * 86400_000 - 5000);
    // Explicit values and explicit "none" win.
    const b = (await user.post("/v1/addresses", { site_name: "B", expires_in_days: 2, max_messages: 9 })).json.address;
    expect(b.max_messages).toBe(9);
    expect(b.expires_at).toBeLessThan(now + 3 * 86400_000);
    const c = (await user.post("/v1/addresses", { site_name: "C", expires_at: null, max_messages: null })).json.address;
    expect(c.expires_at).toBeNull();
    expect(c.max_messages).toBeNull();
    // Bitwarden (alias-service API) gets the defaults too.
    const key = (await user.post("/v1/keys", { name: "bw" })).json;
    const res = await t.app.request("/api/alias/random/new?hostname=shop.example", {
      method: "POST",
      headers: { authentication: key.token ?? key.key, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    const list = (await user.get("/v1/addresses?limit=50")).json.addresses as any[];
    expect(list.find((x) => x.site_name === "shop.example").max_messages).toBe(5);
  });
});
