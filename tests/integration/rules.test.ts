import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addDomain, ingest, makeTestApp, setupAdmin, simpleEml, SECRET, type Client, type TestApp } from "../helpers.js";
import { fakeMail, SmtpError } from "../mail-fakes.js";
import { messageRaw, messages } from "../../app/server/db/schema.js";
import { patternProblem, safeTest } from "../../app/server/services/rules/regex.js";
import { reportSignature } from "../../app/server/routes/ingest.js";

const RELAY = "smtps://u:p@smtp.relay.example:465";

async function setup(env: Record<string, string> = {}) {
  const fake = fakeMail();
  const t = makeTestApp(env, { mail: fake.clients });
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const dest = async (email: string) => {
    const d = (await admin.post("/v1/destinations", { email })).json.destination;
    await admin.post(`/v1/destinations/${d.id}/refresh`);
    return d as { id: string; email: string };
  };
  const main = await dest("me@personal.example");
  const a = (await admin.post("/v1/addresses", { site_name: "Shop", site_url: "https://shop.com" })).json.address;
  await admin.patch(`/v1/addresses/${a.id}`, { forward_enabled: true, destination_id: main.id });
  return { t, admin, a, main, dest, ...fake };
}

const rule = (admin: Client, body: Record<string, unknown>) => admin.post("/v1/rules", { name: "r", ...body });

function withAttachment(subject = "Invoice") {
  return [
    "From: Shop <billing@shop.com>",
    "To: someone@mail.example.test",
    `Subject: ${subject}`,
    "Message-ID: <att-1@shop.com>",
    "X-Mailer: ShopMailer 3",
    "X-Campaign: spring",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your invoice is attached.",
    "--b1",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 fake").toString("base64"),
    "--b1--",
    "",
  ].join("\r\n");
}

const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
const msgRow = (t: TestApp, id: string) => t.deps.db.select().from(messages).where(eq(messages.id, id)).get()!;

describe("rule regex guard", () => {
  it("refuses patterns that can backtrack catastrophically", () => {
    expect(patternProblem("^shop-.*$")).toBeNull();
    expect(patternProblem("(a+)+$")).toMatch(/Repeated groups/);
    expect(patternProblem("(\\w|\\d)*x")).toMatch(/Repeated groups/);
    expect(patternProblem("(a)\\1")).toMatch(/Back-references/);
    expect(patternProblem("x".repeat(201))).toMatch(/longer/);
    expect(patternProblem("[")).toMatch(/valid/);
    expect(safeTest("(a+)+$", "aaaa")).toBe(false);
    expect(safeTest("^news\\.", "NEWS.shop@mail.example.test")).toBe(true);
  });

  it("is enforced by the API", async () => {
    const { admin } = await setup();
    const r = await rule(admin, { conditions: [{ type: "recipient_matches", value: "(a+)+" }], actions: [{ type: "block" }] });
    expect(r.status).toBe(400);
  });
});

describe("rules", () => {
  it("creates, lists, edits, reorders and deletes rules", async () => {
    const { admin } = await setup();
    const one = (await rule(admin, { name: "one", conditions: [{ type: "has_code" }], actions: [{ type: "mark_read" }] })).json.rule;
    const two = (await rule(admin, { name: "two", conditions: [{ type: "is_newsletter" }], actions: [{ type: "quarantine" }] })).json.rule;
    expect([one.position, two.position]).toEqual([0, 1]);
    expect((await admin.patch(`/v1/rules/${one.id}`, { enabled: false })).json.rule.enabled).toBe(false);
    const re = await admin.post("/v1/rules/reorder", { ids: [two.id, one.id] });
    expect(re.json.rules.map((x: { name: string }) => x.name)).toEqual(["two", "one"]);
    expect((await admin.post("/v1/rules/reorder", { ids: [two.id] })).status).toBe(400);
    expect((await rule(admin, { conditions: [{ type: "has_code" }], actions: [{ type: "block" }, { type: "quarantine" }] })).status).toBe(
      400,
    );
    expect(
      (await rule(admin, { conditions: [{ type: "has_code" }], actions: [{ type: "forward_to", destination_id: "dst_nope" }] })).status,
    ).toBe(400);
    expect((await admin.del(`/v1/rules/${one.id}`)).status).toBe(200);
    expect((await admin.get("/v1/rules")).json.rules).toHaveLength(1);
  });

  it("blocks mail and can block the sender and pause the address", async () => {
    const { t, admin, a } = await setup();
    await rule(admin, {
      match: "all",
      conditions: [
        { type: "sender_domain", value: "spam.example" },
        { type: "subject_contains", value: "WIN" },
      ],
      actions: [{ type: "block" }, { type: "block_sender" }, { type: "pause_address" }],
    });
    const ok = await ingest(t, a.email, simpleEml({ text: "hi", subject: "win", from: "x@other.example" }));
    expect(ok.json.action).toBe("forward");
    const r = await ingest(t, a.email, simpleEml({ text: "hi", subject: "You WIN", from: "x@news.spam.example" }));
    expect(r.json).toMatchObject({ action: "reject", reason: "rule_blocked" });
    const addr = (await admin.get(`/v1/addresses/${a.id}`)).json.address;
    expect(addr.blocked_senders).toContain("news.spam.example");
    expect(addr.status).toBe("paused");
    expect((await admin.get("/v1/rules")).json.rules[0].match_count).toBe(1);
  });

  it("combines conditions with OR, negation and stop", async () => {
    const { t, admin, a } = await setup();
    await rule(admin, {
      name: "codes read",
      match: "any",
      conditions: [{ type: "has_code" }, { type: "header_equals", name: "X-Priority", value: "1" }],
      actions: [{ type: "mark_read" }, { type: "stop" }],
    });
    await rule(admin, { name: "never reached", conditions: [{ type: "has_code" }], actions: [{ type: "block" }] });
    await rule(admin, {
      name: "not shop",
      conditions: [{ type: "sender_domain", value: "shop.com", negate: true }],
      actions: [{ type: "mark_read" }],
    });
    const r = (await ingest(t, a.email, simpleEml({ text: "Your code is 123456", from: "a@shop.com" }))).json;
    expect(r.action).toBe("forward");
    const m = (await admin.get(`/v1/messages/${r.message_id}`)).json.message;
    expect(m.read_at).not.toBeNull();
    expect(m.matched_rules.map((x: { name: string }) => x.name)).toEqual(["codes read"]);
    const r2 = (await ingest(t, a.email, simpleEml({ text: "hello", from: "a@shop.com" }))).json;
    expect((await admin.get(`/v1/messages/${r2.message_id}`)).json.message.matched_rules).toEqual([]);
  });

  it("applies scoped rules only to their address or category", async () => {
    const { t, admin, a } = await setup();
    const other = (await admin.post("/v1/addresses", { site_name: "Other" })).json.address;
    await rule(admin, { address_id: other.id, conditions: [{ type: "subject_contains", value: "x" }], actions: [{ type: "block" }] });
    expect((await ingest(t, a.email, simpleEml({ text: "1", subject: "x" }))).json.action).toBe("forward");
    expect((await ingest(t, other.email, simpleEml({ text: "1", subject: "x" }))).json.action).toBe("reject");
  });

  it("forwards to a specific destination and moves the address to a category", async () => {
    const { t, admin, a, dest } = await setup();
    const work = await dest("work@job.example");
    const cat = (await admin.post("/v1/categories", { name: "Bills" })).json.category;
    await rule(admin, {
      conditions: [{ type: "has_attachments" }, { type: "size_over_kb", value: 0 }],
      actions: [
        { type: "forward_to", destination_id: work.id },
        { type: "set_category", category_id: cat.id },
      ],
    });
    const r = (await ingest(t, a.email, withAttachment())).json;
    expect(r).toMatchObject({ action: "forward", forward_to: "work@job.example" });
    expect((await admin.get(`/v1/addresses/${a.id}`)).json.address.category_id).toBe(cat.id);
  });

  it("strips attachments from the forwarded copy only", async () => {
    const { t, admin, a } = await setup();
    await rule(admin, { conditions: [{ type: "has_attachments" }], actions: [{ type: "strip_attachments" }] });
    const r = (await ingest(t, a.email, withAttachment())).json;
    expect(r.forward_to).toBeUndefined();
    expect(r.send).toHaveLength(1);
    const copy = decode(r.send[0].raw_base64);
    expect(copy).not.toContain("JVBERi0x"); // the PDF bytes
    expect(copy).toContain("Subject: Invoice");
    expect(copy).toMatch(/^From: .*<.*@mail\.example\.test>/m);
    expect(copy).toContain("Reply-To:");
    expect(Buffer.from(copy.split("base64\r\n\r\n")[1]!.split("\r\n--")[0]!, "base64").toString()).toContain(
      "1 attachment(s) removed by Throwaway Mail: invoice.pdf",
    );
    expect((await admin.get(`/v1/messages/${r.message_id}`)).json.message.attachments).toHaveLength(1);
  });

  it("evaluates DMARC/SPF failures and headers from Authentication-Results", async () => {
    const { t, admin, a } = await setup();
    await rule(admin, { conditions: [{ type: "auth_failed", value: "dmarc" }], actions: [{ type: "quarantine" }] });
    const eml = "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=shop.com; spf=pass\r\n" + simpleEml({ text: "x" });
    expect((await ingest(t, a.email, eml)).json.action).toBe("store_only");
    expect((await ingest(t, a.email, simpleEml({ text: "y" }))).json.action).toBe("forward");
  });

  it("previews conditions against recent mail", async () => {
    const { t, admin, a } = await setup();
    await ingest(t, a.email, simpleEml({ text: "Your code is 123456", subject: "Code" }));
    await ingest(t, a.email, simpleEml({ text: "News", subject: "Weekly news" }));
    const r = await admin.post("/v1/rules/test", { conditions: [{ type: "subject_contains", value: "news" }] });
    expect(r.json).toMatchObject({ tested: 2, matched: 1 });
    const code = await admin.post("/v1/rules/test", { conditions: [{ type: "has_code" }], address_id: a.id });
    expect(code.json.results.find((x: { matched: boolean }) => x.matched).subject).toBe("Code");
  });
});

describe("quarantine", () => {
  async function quarantined(env: Record<string, string> = {}) {
    const s = await setup(env);
    await rule(s.admin, { conditions: [{ type: "subject_contains", value: "suspicious" }], actions: [{ type: "quarantine" }] });
    const r = (await ingest(s.t, s.a.email, simpleEml({ text: "x", subject: "suspicious" }))).json;
    expect(r.action).toBe("store_only");
    return { ...s, id: r.message_id as string };
  }

  it("holds mail, lists it and releases it without forwarding", async () => {
    const { t, admin, id } = await quarantined();
    const list = (await admin.get("/v1/quarantine")).json.messages;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, subject: "suspicious", matched_rules: [{ name: "r" }] });
    expect(t.deps.db.select().from(messageRaw).where(eq(messageRaw.messageId, id)).get()!.keepUntil).toBeNull();
    // No SMTP: forwarding now is impossible, releasing into the inbox is fine.
    expect((await admin.post(`/v1/quarantine/${id}/release`, {})).status).toBe(409);
    expect((await admin.post(`/v1/quarantine/${id}/release`, { forward: false })).json).toMatchObject({ ok: true, forwarded_to: [] });
    expect((await admin.get("/v1/quarantine")).json.messages).toHaveLength(0);
    expect(msgRow(t, id).quarantinedAt).toBeNull();
  });

  it("releases and forwards over SMTP, or deletes", async () => {
    const { t, admin, a, id, smtp } = await quarantined({ SMTP_RELAY_URL: RELAY });
    const r = await admin.post(`/v1/quarantine/${id}/release`, {});
    expect(r.json).toMatchObject({ forwarded_to: ["me@personal.example"], failed: 0 });
    expect(smtp.sent.at(-1)).toMatchObject({ to: ["me@personal.example"], from: a.email });
    expect(msgRow(t, id)).toMatchObject({ forwarded: true, forwardTo: "me@personal.example" });
    const r2 = (await ingest(t, a.email, simpleEml({ text: "z", subject: "suspicious again" }))).json;
    expect((await admin.del(`/v1/quarantine/${r2.message_id}`)).status).toBe(200);
    expect(t.deps.db.select().from(messages).where(eq(messages.id, r2.message_id)).get()).toBeUndefined();
  });
});

describe("original headers", () => {
  it("keeps the full header section and long values", async () => {
    const { t, admin, a } = await setup();
    const long = "x".repeat(5000);
    const r = (await ingest(t, a.email, `X-Long: ${long}\r\n` + simpleEml({ text: "hi" }))).json;
    const m = (await admin.get(`/v1/messages/${r.message_id}`)).json.message;
    expect(m.raw_headers).toContain(`X-Long: ${long}`);
    expect(m.raw_headers).not.toContain("hi");
    expect(m.headers.find((h: { key: string }) => h.key === "x-long").value).toHaveLength(5000);
  });

  it("forwards only allowed original headers when an allowlist is set", async () => {
    const { t, admin, a } = await setup();
    expect((await admin.get("/v1/forwarding/headers")).json.allowlist).toBeNull();
    expect((await admin.put("/v1/forwarding/headers", { allowlist: ["X-Mailer"] })).json.allowlist).toEqual(["x-mailer"]);
    const r = (await ingest(t, a.email, withAttachment())).json;
    const copy = decode(r.send[0].raw_base64);
    expect(copy).toContain("X-Mailer: ShopMailer 3");
    expect(copy).not.toContain("X-Campaign");
    expect(copy).toContain("Subject: Invoice");
    await admin.put("/v1/forwarding/headers", { allowlist: null });
    const plain = (await ingest(t, a.email, withAttachment().replace("att-1", "att-2"))).json;
    expect(plain).toMatchObject({ action: "forward", forward_to: "me@personal.example" });
  });
});

describe("fallback destinations and failed deliveries", () => {
  async function report(t: TestApp, body: unknown) {
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await t.app.request("/ingest/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tm-timestamp": ts, "x-tm-signature": reportSignature(SECRET, ts, raw) },
      body: raw,
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  it("tells the Worker the fallback chain, address-level first", async () => {
    const { t, admin, a, dest } = await setup();
    const b = await dest("backup@me.example");
    const c = await dest("other@me.example");
    expect((await admin.put("/v1/forwarding/fallbacks", { destination_ids: [b.id, c.id] })).status).toBe(200);
    let r = (await ingest(t, a.email, simpleEml({ text: "1" }))).json;
    expect(r.fallback_to).toEqual(["backup@me.example", "other@me.example"]);
    await admin.put(`/v1/addresses/${a.id}/fallbacks`, { destination_ids: [c.id] });
    expect((await admin.get(`/v1/addresses/${a.id}`)).json.address.fallback_destination_ids).toEqual([c.id]);
    r = (await ingest(t, a.email, simpleEml({ text: "2" }))).json;
    expect(r.fallback_to).toEqual(["other@me.example"]);
    expect((await admin.put(`/v1/addresses/${a.id}/fallbacks`, { destination_ids: ["dst_x"] })).status).toBe(400);
  });

  it("records failures reported by the Worker and lets the user dismiss them", async () => {
    const { t, admin, a } = await setup();
    const r = (await ingest(t, a.email, simpleEml({ text: "1", subject: "Order" }))).json;
    const bad = await report(t, { message_id: r.message_id, deliveries: [] });
    expect(bad.status).toBe(200);
    const forged = await t.app.request("/ingest/report", {
      method: "POST",
      headers: { "x-tm-timestamp": String(Math.floor(Date.now() / 1000)), "x-tm-signature": "0".repeat(64) },
      body: "{}",
    });
    expect(forged.status).toBe(401);
    await report(t, {
      message_id: r.message_id,
      deliveries: [
        { to: "me@personal.example", ok: false, error: "Error: destination address not verified" },
        { to: "backup@me.example", ok: true, fallback_for: "me@personal.example" },
      ],
    });
    expect(msgRow(t, r.message_id).forwardTo).toBe("backup@me.example");
    const list = (await admin.get("/v1/delivery-failures")).json.failures;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      destination: "me@personal.example",
      kind: "rejected",
      delivered_to: "backup@me.example",
      subject: "Order",
      address: a.email,
      can_retry: false,
    });
    expect(list[0].reason).toMatch(/not verified/);
    expect((await admin.get("/v1/delivery-failures?kind=failed")).json.failures).toHaveLength(0);
    await admin.post(`/v1/delivery-failures/${list[0].id}/dismiss`);
    expect((await admin.get("/v1/delivery-failures")).json.failures).toHaveLength(0);
    expect((await admin.get("/v1/delivery-failures?status=resolved")).json.failures).toHaveLength(1);
  });

  it("retries a failed delivery over SMTP", async () => {
    const { t, admin, a, smtp } = await setup({ SMTP_RELAY_URL: RELAY });
    const r = (await ingest(t, a.email, simpleEml({ text: "1" }))).json;
    await report(t, { message_id: r.message_id, deliveries: [{ to: "me@personal.example", ok: false, error: "timeout" }] });
    const [f] = (await admin.get("/v1/delivery-failures")).json.failures;
    expect(f).toMatchObject({ kind: "failed", can_retry: true, reason: "The mail server did not answer in time." });
    smtp.failWith = new SmtpError("550 5.1.1 user unknown", true);
    const again = (await admin.post(`/v1/delivery-failures/${f.id}/retry`)).json;
    expect(again).toMatchObject({ delivered: false, failure: { kind: "rejected", retry_count: 1 } });
    smtp.failWith = null;
    const ok = (await admin.post(`/v1/delivery-failures/${f.id}/retry`)).json;
    expect(ok.delivered).toBe(true);
    expect(smtp.sent.at(-1)!.to).toEqual(["me@personal.example"]);
    expect(msgRow(t, r.message_id).forwarded).toBe(true);
  });
});
