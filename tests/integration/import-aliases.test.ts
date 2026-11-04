import { describe, expect, it } from "vitest";
import { addDomain, makeTestApp, setupAdmin } from "../helpers.js";
import { csvLine, parseCsv } from "../../app/server/lib/csv.js";
import { parseAliasFile } from "../../app/server/services/importers.js";

// Layouts documented in docs/import.md.
const SIMPLELOGIN = [
  "alias,note,enabled,mailboxes",
  "github.x7k2@simplelogin.com,GitHub,True,me@example.org",
  'shop_42@aleeas.com,"Shop, the one with ""deals""",False,me@example.org other@example.org',
  "Bad Local!@simplelogin.com,,True,me@example.org",
  "",
].join("\r\n");

const ADDY = [
  "id,user_id,aliasable_id,aliasable_type,local_part,extension,domain,email,active,description,emails_forwarded,created_at,updated_at,deleted_at",
  "a1,u1,,,netflix,,anonaddy.me,netflix@anonaddy.me,1,Netflix,3,2025-01-01 10:00:00,2025-01-01 10:00:00,",
  "a2,u1,,,old,,anonaddy.me,old@anonaddy.me,0,,0,2024-01-01 10:00:00,2024-01-01 10:00:00,2024-06-01 10:00:00",
  "a3,u1,,,news,,mine.example.test,news@mine.example.test,1,Newsletter,0,2025-01-01 10:00:00,2025-01-01 10:00:00,",
].join("\n");

async function setup() {
  const t = makeTestApp();
  const user = await setupAdmin(t);
  await addDomain(user, "mail.example.test");
  await addDomain(user, "mine.example.test");
  return { t, user };
}

describe("CSV helpers", () => {
  it("parses quotes, doubled quotes and line ends, and escapes formulas", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([
      ["a", "b,c", 'd "e"'],
      ["1", "2", "3"],
    ]);
    expect(csvLine(["=cmd()", "x,y", null])).toBe(`'=cmd(),"x,y",`);
  });

  it("detects the source format", () => {
    expect(parseAliasFile(SIMPLELOGIN).format).toBe("simplelogin");
    expect(parseAliasFile(ADDY).format).toBe("addy");
    expect(parseAliasFile(JSON.stringify({ data: [{ email: "a@b.c", local_part: "a", active: true }] })).format).toBe("addy");
    expect(() => parseAliasFile("foo,bar\n1,2")).toThrow(/Unrecognised/);
  });
});

describe("alias import", () => {
  it("previews then imports a SimpleLogin export onto a chosen domain", async () => {
    const { user } = await setup();
    const preview = await user.post("/v1/import/aliases", { content: SIMPLELOGIN, domain: "mail.example.test" });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ format: "simplelogin", dry_run: true, total: 3, created: 2, skipped: 1 });
    expect(preview.json.rows[0]).toMatchObject({ email: "github.x7k2@mail.example.test", site_name: "GitHub", action: "create" });
    expect(preview.json.rows[1]).toMatchObject({ email: "shop_42@mail.example.test", status: "paused" });
    expect(preview.json.rows[2].reason).toMatch(/not an e-mail|not allowed/);
    expect((await user.get("/v1/addresses?status=all")).json.addresses).toHaveLength(0);

    const done = await user.post("/v1/import/aliases", {
      content: SIMPLELOGIN,
      domain: "mail.example.test",
      dry_run: false,
      category: "Imported",
    });
    expect(done.json).toMatchObject({ dry_run: false, created: 2 });
    const list = (await user.get("/v1/addresses?status=all")).json.addresses;
    expect(list.map((a: any) => a.email).sort()).toEqual(["github.x7k2@mail.example.test", "shop_42@mail.example.test"]);
    expect(list.find((a: any) => a.local_part === "shop_42").status).toBe("paused");

    // Second run: already there.
    const again = await user.post("/v1/import/aliases", { content: SIMPLELOGIN, domain: "mail.example.test" });
    expect(again.json.created).toBe(0);
    expect(again.json.rows[0].reason).toMatch(/already exists/);
  });

  it("imports addy.io keeping the alias's own domain when it belongs to the instance, or random local parts", async () => {
    const { user } = await setup();
    const keep = await user.post("/v1/import/aliases", { content: ADDY, dry_run: false });
    expect(keep.json.rows.map((r: any) => r.action)).toEqual(["skip", "skip", "create"]);
    expect(keep.json.rows[0].reason).toMatch(/not a domain of this instance/);
    expect(keep.json.rows[1].reason).toMatch(/deleted/);
    const rnd = await user.post("/v1/import/aliases", { content: ADDY, domain: "mail.example.test", local_part: "random", dry_run: false });
    expect(rnd.json.created).toBe(2);
    expect(rnd.json.rows[0].email).toMatch(/@mail\.example\.test$/);
    expect(rnd.json.rows[0].email).not.toBe("netflix@mail.example.test");
  });

  it("exports a CSV that imports back", async () => {
    const { t, user } = await setup();
    await user.post("/v1/addresses", { site_name: "GitHub", site_url: "github.com", local_part: "gh-1", label: "=evil" });
    const res = await t.app.request("/v1/export/aliases.csv", { headers: { cookie: user.cookie } });
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const csv = await res.text();
    expect(csv.split("\r\n")[0]).toBe("alias,note,enabled,site_name,site_url,category,created_at");
    expect(csv).toContain("gh-1@mail.example.test,'=evil,true,GitHub,https://github.com,,");
    const back = await user.post("/v1/import/aliases", { content: csv, domain: "mine.example.test" });
    expect(back.json).toMatchObject({ format: "throwaway", created: 1 });
    expect(back.json.rows[0]).toMatchObject({ email: "gh-1@mine.example.test", site_name: "GitHub" });
  });
});
