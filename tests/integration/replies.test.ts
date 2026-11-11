import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addDomain, ingest, makeTestApp, setupAdmin, simpleEml, type Client, type TestApp } from "../helpers.js";
import { fakeMail, SmtpError } from "../mail-fakes.js";
import { domains } from "../../app/server/db/schema.js";
import { pollMailbox } from "../../app/server/services/mailbox/poller.js";
import { relaySettings } from "../../app/server/services/replies.js";

const RELAY = "smtps://relay-user:relay%20pass@smtp.relay.example:465";

async function setup(env: Record<string, string> = { SMTP_RELAY_URL: RELAY }) {
  const fake = fakeMail();
  const t = makeTestApp(env, { mail: fake.clients });
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const d = (await admin.post("/v1/destinations", { email: "me@personal.example" })).json.destination;
  await admin.post(`/v1/destinations/${d.id}/refresh`);
  const a = (await admin.post("/v1/addresses", { site_name: "Shop" })).json.address;
  await admin.patch(`/v1/addresses/${a.id}`, { forward_enabled: true, destination_id: d.id });
  return { t, admin, a, ...fake };
}

const AUTH_PASS =
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=personal.example; spf=pass smtp.mailfrom=me@personal.example";

function reply(to: string, opts: { from?: string; auth?: string | null; text?: string } = {}) {
  return [
    ...(opts.auth === null ? [] : [opts.auth ?? AUTH_PASS]),
    "Received: from laptop.home (1.2.3.4) by smtp.personal.example",
    `From: Me Myself <${opts.from ?? "me@personal.example"}>`,
    `To: ${to}`,
    "Subject: Re: Your order",
    "Message-ID: <abc@laptop.personal.example>",
    "In-Reply-To: <order-1@shop.com>",
    "User-Agent: Thunderbird",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    opts.text ?? "Thanks! -- me@personal.example",
    "",
  ].join("\r\n");
}

async function enableAndReceive(t: TestApp, admin: Client, a: { id: string; email: string }) {
  expect((await admin.patch(`/v1/addresses/${a.id}`, { replies_enabled: true })).status).toBe(200);
  const res = (
    await ingest(
      t,
      a.email,
      simpleEml({ subject: "Your order", text: "Shipped", from: "Shop Team <orders@shop.com>", messageId: "<order-1@shop.com>" }),
    )
  ).json;
  const contacts = (await admin.get(`/v1/addresses/${a.id}/contacts`)).json.contacts;
  return { res, contact: contacts[0] };
}

describe("reverse-alias replies", () => {
  it("parses SMTP_RELAY_URL", () => {
    expect(relaySettings(RELAY)).toEqual({
      host: "smtp.relay.example",
      port: 465,
      security: "tls",
      user: "relay-user",
      password: "relay pass",
    });
    expect(relaySettings("smtp://h.example")).toMatchObject({ port: 587, security: "starttls", user: null });
    expect(relaySettings("smtp://h.example:25?tls=none")).toMatchObject({ port: 25, security: "none" });
  });

  it("is unavailable (and refused) without outbound SMTP", async () => {
    const { admin, a } = await setup({});
    const got = (await admin.get(`/v1/addresses/${a.id}`)).json.address;
    expect(got.replies_enabled).toBe(false);
    expect(got.replies_unavailable).toContain("SMTP_RELAY_URL");
    const r = await admin.patch(`/v1/addresses/${a.id}`, { replies_enabled: true });
    expect(r.status).toBe(400);
  });

  it("rewrites forwarded mail with a per-sender reply address", async () => {
    const { t, admin, a } = await setup();
    const { res, contact } = await enableAndReceive(t, admin, a);
    expect(contact).toMatchObject({ email: "orders@shop.com", name: "Shop Team" });
    expect(contact.reverse_address).toMatch(/^r\+[0-9a-f]{24}@mail\.example\.test$/);
    expect(res.forward_to).toBeUndefined();
    expect(res.send).toHaveLength(1);
    expect(res.send[0]).toMatchObject({ from: a.email, to: "me@personal.example" });
    const mime = Buffer.from(res.send[0].raw_base64, "base64").toString("utf8");
    expect(mime).toContain(`From: "Shop Team (orders@shop.com)" <${a.email}>`);
    expect(mime).toContain(`Reply-To: "Shop Team (orders@shop.com)" <${contact.reverse_address}>`);
    expect(mime).toContain("Shipped");
    expect(mime).not.toMatch(/^From: Shop Team <orders@shop.com>/m);

    // Read-receipt and error-report requests would be answered from the user's real mailbox: they are dropped.
    const receipt = [
      "From: orders@shop.com",
      `To: ${a.email}`,
      "Subject: Did you read this?",
      "Message-ID: <receipt-1@shop.com>",
      "Disposition-Notification-To: track@shop.com",
      "Return-Receipt-To: track@shop.com",
      "X-Confirm-Reading-To: track@shop.com",
      "Errors-To: track@shop.com",
      "",
      "Hello",
      "",
    ].join("\r\n");
    const copy = Buffer.from((await ingest(t, a.email, receipt)).json.send[0].raw_base64, "base64").toString("utf8");
    expect(copy).toContain("Subject: Did you read this?");
    expect(copy).not.toContain("track@shop.com");

    // Same sender again: same contact.
    await ingest(t, a.email, simpleEml({ text: "Again", from: "orders@shop.com" }));
    expect((await admin.get(`/v1/addresses/${a.id}/contacts`)).json.contacts).toHaveLength(1);
  });

  it("relays an authenticated reply from a verified destination, without the user's identity", async () => {
    const { t, admin, a, smtp } = await setup();
    const { contact } = await enableAndReceive(t, admin, a);
    const r = (await ingest(t, contact.reverse_address, reply(contact.reverse_address), { from: "me@personal.example" })).json;
    expect(r).toMatchObject({ action: "store_only", reason: "reply_sent" });
    expect(smtp.sent).toHaveLength(1);
    const sent = smtp.sent[0]!;
    expect(sent.settings).toMatchObject({ host: "smtp.relay.example", user: "relay-user" });
    expect(sent).toMatchObject({ from: a.email, to: ["orders@shop.com"] });
    expect(sent.raw).toContain(`From: <${a.email}>`);
    expect(sent.raw).toContain('To: "Shop Team" <orders@shop.com>');
    expect(sent.raw).toContain("Subject: Re: Your order");
    expect(sent.raw).toContain("In-Reply-To: <order-1@shop.com>");
    expect(sent.raw).toContain(`Thanks! -- ${a.email}`);
    for (const leak of ["personal.example", "laptop", "1.2.3.4", "Thunderbird", "Myself"]) expect(sent.raw).not.toContain(leak);
    expect((await admin.get(`/v1/addresses/${a.id}/contacts`)).json.contacts[0].reply_count).toBe(1);
    // Not stored as a message of the address.
    expect((await admin.get(`/v1/addresses/${a.id}`)).json.address.message_count).toBe(1);
  });

  it("refuses replies from strangers, unauthenticated mail, blocked contacts and disabled addresses", async () => {
    const { t, admin, a, smtp } = await setup();
    const { contact } = await enableAndReceive(t, admin, a);
    const to = contact.reverse_address;
    expect((await ingest(t, to, reply(to, { from: "attacker@evil.example" }))).json).toMatchObject({
      action: "reject",
      reason: "reply_not_allowed",
    });
    expect((await ingest(t, to, reply(to, { auth: null }))).json).toMatchObject({ action: "reject", reason: "reply_not_allowed" });
    expect((await ingest(t, to, reply(to, { auth: "Authentication-Results: mx; dkim=pass; spf=pass; dmarc=fail" }))).json.reason).toBe(
      "reply_not_allowed",
    );
    expect((await ingest(t, "r+000000000000000000000000@mail.example.test", reply(to))).json.reason).toBe("unknown_recipient");

    await admin.patch(`/v1/addresses/${a.id}/contacts/${contact.id}`, { blocked: true });
    expect((await ingest(t, to, reply(to))).json.reason).toBe("replies_disabled");
    await admin.patch(`/v1/addresses/${a.id}/contacts/${contact.id}`, { blocked: false });
    await admin.patch(`/v1/addresses/${a.id}`, { replies_enabled: false });
    expect((await ingest(t, to, reply(to))).json.reason).toBe("replies_disabled");
    expect(smtp.sent).toHaveLength(0);
  });

  it("bounces when the relay fails", async () => {
    const { t, admin, a, smtp } = await setup();
    const { contact } = await enableAndReceive(t, admin, a);
    smtp.failWith = new SmtpError("451 try later", false);
    expect((await ingest(t, contact.reverse_address, reply(contact.reverse_address))).json).toMatchObject({
      action: "reject",
      reason: "reply_failed",
    });
  });

  it("uses the mailbox SMTP server on IMAP domains", async () => {
    const fake = fakeMail();
    const t = makeTestApp({ APP_SECRET: "s".repeat(40) }, { mail: fake.clients });
    const admin = await setupAdmin(t);
    await admin.post("/v1/domains", {
      name: "imap.example.test",
      transport: "imap",
      mailbox: {
        imap_host: "imap.p.example",
        imap_user: "c@p.example",
        imap_password: "imap-pass",
        smtp_host: "smtp.p.example",
        smtp_from: "c@p.example",
      },
    });
    const dest = (await admin.post("/v1/destinations", { email: "me@personal.example", verify_by: "app" })).json.destination;
    const token = /verify\/([\w-]+)/.exec(fake.smtp.sent.at(-1)!.raw)![1];
    await t.app.request(`/v1/destinations/verify/${token}`);
    fake.smtp.sent.length = 0;
    const a = (await admin.post("/v1/addresses", { site_name: "Shop", domain: "imap.example.test" })).json.address;
    await admin.patch(`/v1/addresses/${a.id}`, { forward_enabled: true, destination_id: dest.id });
    expect((await admin.patch(`/v1/addresses/${a.id}`, { replies_enabled: true })).status).toBe(200);
    const dom = t.deps.db.select().from(domains).where(eq(domains.name, "imap.example.test")).get()!;

    fake.imap.deliver(simpleEml({ text: "Shipped", from: "orders@shop.com" }).replace("To: someone@mail.example.test", `To: ${a.email}`));
    await pollMailbox(t.deps, dom);
    expect(fake.smtp.sent).toHaveLength(1);
    expect(fake.smtp.sent[0]!.to).toEqual(["me@personal.example"]);
    const reverse = /Reply-To: .*<(r\+[0-9a-f]+@imap\.example\.test)>/.exec(fake.smtp.sent[0]!.raw)![1]!;

    fake.imap.deliver(reply(reverse));
    await pollMailbox(t.deps, dom);
    expect(fake.smtp.sent).toHaveLength(2);
    expect(fake.smtp.sent[1]).toMatchObject({ from: "c@p.example", to: ["orders@shop.com"] });
    expect(fake.smtp.sent[1]!.raw).toContain(`From: <${a.email}>`);
  });
});
