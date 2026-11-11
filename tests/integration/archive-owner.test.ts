import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml, type TestApp } from "../helpers.js";
import { addresses } from "../../app/server/db/schema.js";

let t: TestApp;
let admin: Client;

beforeEach(async () => {
  t = makeTestApp();
  admin = await setupAdmin(t);
});

describe("archive and delete messages", () => {
  it("archives, lists the archive, unarchives and deletes", async () => {
    await addDomain(admin);
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json;
    const m1 = (await ingest(t, a.email, simpleEml({ text: "one" }))).json.message_id;
    const m2 = (await ingest(t, a.email, simpleEml({ text: "two" }))).json.message_id;
    expect((await admin.patch(`/v1/messages/${m1}`, { archived: true })).status).toBe(200);
    const inbox = (await admin.get(`/v1/addresses/${a.id}/messages`)).json.messages.map((m: any) => m.id);
    const archive = (await admin.get(`/v1/addresses/${a.id}/messages?archived=true`)).json.messages;
    expect(inbox).toEqual([m2]);
    expect(archive.map((m: any) => m.id)).toEqual([m1]);
    expect(archive[0].read_at).toBeTruthy(); // archiving marks as read
    expect((await admin.get(`/v1/addresses/${a.id}`)).json.address).toMatchObject({ unread_count: 1, message_count: 2 });
    await admin.patch(`/v1/messages/${m1}`, { archived: false });
    expect((await admin.get(`/v1/addresses/${a.id}/messages`)).json.messages).toHaveLength(2);
    expect((await admin.del(`/v1/messages/${m2}`)).status).toBe(200);
    expect((await admin.get(`/v1/addresses/${a.id}/messages?archived=all`)).json.messages.map((m: any) => m.id)).toEqual([m1]);
  });

  it("bulk actions by scope and by ids, scoped to the owner", async () => {
    await addDomain(admin);
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await ingest(t, a.email, simpleEml({ text: `m${i}` }))).json.message_id);
    expect((await admin.post(`/v1/addresses/${a.id}/messages/bulk`, { action: "read", scope: "inbox" })).json.affected).toBe(3);
    expect((await admin.post(`/v1/addresses/${a.id}/messages/bulk`, { action: "archive", ids: [ids[0], ids[1]] })).json.affected).toBe(2);
    expect((await admin.post(`/v1/addresses/${a.id}/messages/bulk`, { action: "delete", scope: "archived" })).json.affected).toBe(2);
    expect((await admin.get(`/v1/addresses/${a.id}/messages?archived=all`)).json.messages.map((m: any) => m.id)).toEqual([ids[2]]);
    expect((await admin.post(`/v1/addresses/${a.id}/messages/bulk`, { action: "delete" })).status).toBe(400);
    const other = loginAs(t, "other@example.org");
    expect((await other.post(`/v1/addresses/${a.id}/messages/bulk`, { action: "delete", scope: "all" })).status).toBe(404);
  });
});

describe("domain owner", () => {
  it("can be chosen at creation and transferred with its To sort box", async () => {
    const bob = loginAs(t, "bob@example.org");
    const bobId = (await bob.get("/v1/auth/me")).json.user.id;
    const dom = await addDomain(admin, "catchall.example.test");
    expect(dom.owner.email).toBe("admin@example.org");
    await ingest(t, "someone@catchall.example.test", simpleEml({ text: "x" }));
    expect((await admin.get("/v1/review")).json.total).toBe(1);

    const moved = await admin.patch(`/v1/domains/${dom.id}`, { owner_id: bobId });
    expect(moved.json.domain.owner.email).toBe("bob@example.org");
    expect((await admin.get("/v1/review")).json.total).toBe(0);
    const review = (await bob.get("/v1/review")).json;
    expect(review.items).toMatchObject([{ recipient: "someone@catchall.example.test", count: 1 }]);
    // next unknown mail lands in bob's box too
    await ingest(t, "other@catchall.example.test", simpleEml({ text: "y" }));
    expect((await bob.get("/v1/review")).json.total).toBe(2);
    expect((await admin.get("/v1/admin/audit")).json.entries.some((e: any) => e.action === "domain.owner_changed")).toBe(true);

    const created = (await admin.post("/v1/domains", { name: "x.example.test", owner_id: bobId })).json.domain;
    expect(created.owner.email).toBe("bob@example.org");
    expect((await admin.post("/v1/domains", { name: "y.example.test", owner_id: "usr_nope" })).status).toBe(400);
  });

  it("does not let the previous owner keep reading the To sort box through its feed", async () => {
    const bob = loginAs(t, "bob@example.org");
    const bobId = (await bob.get("/v1/auth/me")).json.user.id;
    const dom = await addDomain(admin, "catchall.example.test");
    await ingest(t, "someone@catchall.example.test", simpleEml({ text: "x" }));
    const box = t.deps.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.domainId, dom.id), eq(addresses.isUnassigned, true)))
      .get()!;
    const token = (await admin.post(`/v1/addresses/${box.id}/feed`, { enabled: true })).json.address.feed_token;
    expect((await t.app.request(`/feeds/${token}.json`)).status).toBe(200);

    await admin.patch(`/v1/domains/${dom.id}`, { owner_id: bobId });
    await ingest(t, "other@catchall.example.test", simpleEml({ text: "for bob" }));
    expect((await t.app.request(`/feeds/${token}.json`)).status).toBe(404);
    const moved = t.deps.db.select().from(addresses).where(eq(addresses.id, box.id)).get()!;
    expect(moved).toMatchObject({ userId: bobId, feedToken: null, forwardEnabled: false, destinationId: null });
  });
});
