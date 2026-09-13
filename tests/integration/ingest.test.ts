import { beforeEach, describe, expect, it } from "vitest";
import { Client, addDomain, fixture, ingest, makeTestApp, setupAdmin, simpleEml, type TestApp } from "../helpers.js";

let t: TestApp;
let admin: Client;
let addr: { id: string; email: string };

beforeEach(async () => {
  t = makeTestApp();
  admin = await setupAdmin(t);
  await addDomain(admin);
  const r = await admin.post("/v1/addresses", { site_name: "GitHub", site_url: "github.com" });
  addr = r.json;
});

describe("ingest security", () => {
  it("rejects a bad signature", async () => {
    const r = await ingest(t, addr.email, simpleEml({ text: "hi" }), { secret: "wrong-secret-xxxxxxxxxxxx" });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("bad_signature");
  });
  it("rejects a stale timestamp", async () => {
    const r = await ingest(t, addr.email, simpleEml({ text: "hi" }), { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("stale_timestamp");
  });
  it("rejects a body signed for another recipient", async () => {
    const body = Buffer.from(simpleEml({ text: "hi" }));
    const good = await import("../../app/server/routes/ingest.js").then((m) =>
      m.ingestSignature("test-ingest-secret-0123456789", String(Math.floor(Date.now() / 1000)), "sender@example.com", "other@mail.example.test", body),
    );
    const r = await ingest(t, addr.email, body, { signature: good });
    expect(r.status).toBe(401);
  });
  it("rejects oversize bodies", async () => {
    const small = makeTestApp({ MAX_INGEST_BYTES: "1024" });
    const r = await ingest(small, "x@mail.example.test", Buffer.alloc(4096, 65));
    expect(r.status).toBe(413);
  });
});

describe("ingest routing", () => {
  it("stores mail and extracts the code", async () => {
    const r = await ingest(t, addr.email, fixture("github-device-verification.eml"));
    expect(r.status).toBe(200);
    expect(r.json.action).toBe("store_only");
    const msgs = await admin.get(`/v1/addresses/${addr.id}/messages`);
    expect(msgs.json.messages).toHaveLength(1);
    expect(msgs.json.messages[0].code).toBe("593201");
    const full = await admin.get(`/v1/messages/${r.json.message_id}`);
    expect(full.json.message.auth).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
    expect(full.json.message.html).not.toContain("<script");
  });
  it("matches case-insensitively and ignores plus-tags", async () => {
    const [local, domain] = addr.email.split("@");
    const r = await ingest(t, `${local!.toUpperCase()}+promo@${domain!.toUpperCase()}`, simpleEml({ text: "Your code is 123456" }));
    expect(r.json.action).toBe("store_only");
  });
  it("is idempotent on Message-ID + recipient", async () => {
    const eml = simpleEml({ text: "Your code is 123456", messageId: "<same@x>" });
    const a = await ingest(t, addr.email, eml);
    const b = await ingest(t, addr.email, eml);
    expect(b.json.duplicate).toBe(true);
    expect(b.json.message_id).toBe(a.json.message_id);
    const msgs = await admin.get(`/v1/addresses/${addr.id}/messages`);
    expect(msgs.json.messages).toHaveLength(1);
  });
  it("rejects unknown domains", async () => {
    const r = await ingest(t, "a@nowhere.test", simpleEml({ text: "x" }));
    expect(r.json).toMatchObject({ action: "reject", reason: "unknown_domain" });
  });
  it("applies the reject policy for unknown recipients", async () => {
    const r = await ingest(t, "nobody@mail.example.test", simpleEml({ text: "x" }));
    expect(r.json).toMatchObject({ action: "reject", reason: "unknown_recipient" });
  });
  it("applies the inbox policy (domain owner's unassigned box)", async () => {
    const dom = (await admin.get("/v1/domains")).json.domains[0];
    await admin.patch(`/v1/domains/${dom.id}`, { unknown_policy: "inbox" });
    const r = await ingest(t, "nobody@mail.example.test", simpleEml({ text: "x" }));
    expect(r.json.action).toBe("store_only");
    const list = await admin.get("/v1/addresses");
    const box = list.json.addresses.find((a: any) => a.is_unassigned);
    expect(box.message_count).toBe(1);
  });
  it("applies the auto_create policy", async () => {
    const dom = (await admin.get("/v1/domains")).json.domains[0];
    await admin.patch(`/v1/domains/${dom.id}`, { unknown_policy: "auto_create" });
    const r = await ingest(t, "shop-xyz@mail.example.test", simpleEml({ text: "x" }), { from: "news@shop.example" });
    expect(r.json.action).toBe("store_only");
    const list = await admin.get("/v1/addresses?q=shop-xyz");
    expect(list.json.addresses[0]).toMatchObject({ email: "shop-xyz@mail.example.test", site_name: "shop.example" });
  });
  it("rejects paused and archived addresses", async () => {
    await admin.patch(`/v1/addresses/${addr.id}`, { status: "paused" });
    expect((await ingest(t, addr.email, simpleEml({ text: "x" }))).json).toMatchObject({ action: "reject", reason: "address_paused" });
    await admin.patch(`/v1/addresses/${addr.id}`, { status: "archived" });
    expect((await ingest(t, addr.email, simpleEml({ text: "x" }))).json).toMatchObject({ action: "reject", reason: "address_archived" });
  });
  it("rejects expired addresses", async () => {
    await admin.patch(`/v1/addresses/${addr.id}`, { expires_at: Date.now() - 1000 });
    expect((await ingest(t, addr.email, simpleEml({ text: "x" }))).json.reason).toBe("address_expired");
  });
});

describe("forwarding", () => {
  async function verifiedDestination() {
    const d = await admin.post("/v1/destinations", { email: "me@personal.example" });
    expect(d.json.destination.verified).toBe(false);
    const r = await admin.post(`/v1/destinations/${d.json.destination.id}/refresh`); // mock: owner clicked the link
    expect(r.json.destination.verified).toBe(true);
    return r.json.destination;
  }

  it("forwards only when enabled and the destination is verified", async () => {
    const d = await admin.post("/v1/destinations", { email: "me@personal.example" });
    await admin.patch(`/v1/addresses/${addr.id}`, { forward_enabled: true, destination_id: d.json.destination.id });
    expect((await ingest(t, addr.email, simpleEml({ text: "1" }))).json.action).toBe("store_only"); // not verified yet
    await admin.post(`/v1/destinations/${d.json.destination.id}/refresh`);
    expect((await ingest(t, addr.email, simpleEml({ text: "2" }))).json).toMatchObject({ action: "forward", forward_to: "me@personal.example" });
  });

  it("toggling per address changes the result for the next mail only", async () => {
    const dest = await verifiedDestination();
    await admin.patch(`/v1/addresses/${addr.id}`, { forward_enabled: true, destination_id: dest.id });
    const first = await ingest(t, addr.email, simpleEml({ text: "first", messageId: "<first@x>" }));
    expect(first.json.action).toBe("forward");
    await admin.patch(`/v1/addresses/${addr.id}`, { forward_enabled: false });
    const second = await ingest(t, addr.email, simpleEml({ text: "second" }));
    expect(second.json.action).toBe("store_only");
    // the first message keeps its forwarded state, and a retry of it still says forward
    const m1 = await admin.get(`/v1/messages/${first.json.message_id}`);
    expect(m1.json.message.forwarded).toBe(true);
    expect((await ingest(t, addr.email, simpleEml({ text: "first", messageId: "<first@x>" }))).json.action).toBe("forward");
  });

  it("uses the first verified destination when none is chosen", async () => {
    await verifiedDestination();
    await admin.patch(`/v1/addresses/${addr.id}`, { forward_enabled: true });
    expect((await ingest(t, addr.email, simpleEml({ text: "x" }))).json.forward_to).toBe("me@personal.example");
  });

  it("other addresses are unaffected", async () => {
    const dest = await verifiedDestination();
    const other = (await admin.post("/v1/addresses", { site_name: "Other", forward: true, destination_id: dest.id })).json;
    expect((await ingest(t, other.email, simpleEml({ text: "x" }))).json.action).toBe("forward");
    expect((await ingest(t, addr.email, simpleEml({ text: "x" }))).json.action).toBe("store_only");
  });
});
