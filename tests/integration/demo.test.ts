import { describe, expect, it } from "vitest";
import { Client, FIXTURES, makeTestApp } from "../helpers.js";
import { DEMO_SITES, resetDemo } from "../../app/server/services/demo.js";

async function demoApp() {
  const t = makeTestApp({ DEMO_MODE: "1", DEMO_MAIL_DIR: FIXTURES });
  await resetDemo(t.deps);
  const c = new Client(t);
  const r = await c.post("/v1/auth/demo");
  expect(r.status).toBe(200);
  return { t, c };
}

describe("demo mode", () => {
  it("is off by default", async () => {
    const t = makeTestApp();
    const c = new Client(t);
    expect((await c.post("/v1/auth/demo")).status).toBe(404);
    expect((await c.get("/v1/auth/status")).json.demo).toBeNull();
  });

  it("seeds the demo data with codes and one-click sign-in", async () => {
    const { c } = await demoApp();
    expect((await c.get("/v1/auth/status")).json.demo).toMatchObject({ reset_minutes: 60 });
    const list = (await c.get("/v1/addresses?status=all")).json.addresses;
    for (const s of DEMO_SITES) expect(list.find((a: any) => a.local_part === s.local)?.message_count).toBe(1);
    const gh = list.find((a: any) => a.site_name === "GitHub");
    expect((await c.get(`/v1/addresses/${gh.id}/code`)).json.code).toBe("593201");
    expect(list.find((a: any) => a.site_name === "Forum").no_mail_warning).toBe(true);
    expect((await c.get("/v1/admin/site-rejections")).json.rejections).toHaveLength(1);
    expect((await c.get("/v1/categories")).json.categories.map((x: any) => x.name)).toEqual(["Social", "Games", "Shopping", "Dev"]);
  });

  it("refuses writes that matter and keeps the rest editable", async () => {
    const { c } = await demoApp();
    expect((await c.post("/v1/domains", { name: "evil.example" })).json.error.code).toBe("demo_mode");
    expect((await c.post("/v1/destinations", { email: "x@example.org" })).status).toBe(403);
    expect((await c.post("/v1/keys", { name: "k" })).status).toBe(403);
    expect((await c.post("/v1/notify-targets", { kind: "ntfy", name: "n", url: "https://ntfy.sh/x" })).status).toBe(403);
    expect((await c.patch("/v1/admin/users/x", { role: "user" })).status).toBe(403);
    const rule = { name: "r", conditions: [{ type: "recipient_matches", value: "^x" }], actions: [{ type: "block" }] };
    expect((await c.post("/v1/rules", rule)).status).toBe(403);
    expect((await c.post("/v1/rules/test", rule)).status).toBe(403);
    expect((await c.get("/v1/rules")).status).toBe(200);
    expect((await c.get("/v1/domains")).status).toBe(200);
    expect((await c.post("/v1/addresses", { site_name: "Visitor" })).status).toBe(201);
    expect((await c.post("/v1/categories", { name: "Mine" })).status).toBe(201);
  });

  it("resets to the seed", async () => {
    const { t, c } = await demoApp();
    await c.post("/v1/addresses", { site_name: "Visitor" });
    await resetDemo(t.deps);
    expect((await c.get("/v1/addresses")).status).toBe(401);
    const again = new Client(t);
    await again.post("/v1/auth/demo");
    const list = (await again.get("/v1/addresses?status=all")).json.addresses;
    expect(list.find((a: any) => a.site_name === "Visitor")).toBeUndefined();
  });
});
