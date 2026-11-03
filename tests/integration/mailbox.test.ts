import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, setupAdmin, simpleEml, type Client, type TestApp } from "../helpers.js";
import { fakeMail, SmtpError } from "../mail-fakes.js";
import { domainMailboxes, domains, messages } from "../../app/server/db/schema.js";
import { pollMailbox } from "../../app/server/services/mailbox/poller.js";
import { decryptSecret } from "../../app/server/lib/secrets.js";
import { UnconfiguredCloudflareClient } from "../../app/server/cloudflare/index.js";
import { renderPrometheus } from "../../app/server/services/metrics.js";

const APP_SECRET = "s".repeat(40);
const DOMAIN = "imap.example.test";

const mailbox = (extra: Record<string, unknown> = {}) => ({
  imap_host: "imap.provider.example",
  imap_user: "catchall@provider.example",
  imap_password: "imap-pass",
  smtp_host: "smtp.provider.example",
  smtp_from: "catchall@provider.example",
  ...extra,
});

function mail(to: string, opts: { subject?: string; text?: string; headers?: string[]; messageId?: string } = {}) {
  const base = simpleEml({ subject: opts.subject, text: opts.text ?? "Your code is 123456", messageId: opts.messageId }).replace(
    "To: someone@mail.example.test",
    `To: ${to}`,
  );
  return [...(opts.headers ?? []), base].join("\r\n");
}

async function setup(opts: { cf?: "mock" | "unconfigured"; env?: Record<string, string> } = {}) {
  const fake = fakeMail();
  const t = makeTestApp(
    { APP_SECRET, ...opts.env },
    { mail: fake.clients, ...(opts.cf === "unconfigured" ? { cf: new UnconfiguredCloudflareClient() } : {}) },
  );
  const admin = await setupAdmin(t);
  return { t, admin, ...fake };
}

async function addImapDomain(admin: Client, extra: Record<string, unknown> = {}) {
  const r = await admin.post("/v1/domains", { name: DOMAIN, transport: "imap", unknown_policy: "reject", mailbox: mailbox(extra) });
  expect(r.status).toBe(201);
  return r.json.domain;
}

const domainRow = (t: TestApp) => t.deps.db.select().from(domains).where(eq(domains.name, DOMAIN)).get()!;
const mailboxRow = (t: TestApp) =>
  t.deps.db
    .select()
    .from(domainMailboxes)
    .where(eq(domainMailboxes.domainId, domainRow(t).id))
    .get()!;
const poll = (t: TestApp) => pollMailbox(t.deps, domainRow(t));

/** A verified destination and a forwarding address on the IMAP domain. */
async function forwardingAddress(t: TestApp, admin: Client, smtp: { sent: unknown[] }) {
  const dest = (await admin.post("/v1/destinations", { email: "me@personal.example", verify_by: "app" })).json.destination;
  const token = /verify\/([\w-]+)/.exec((smtp.sent.at(-1) as { raw: string }).raw)![1];
  await t.app.request(`/v1/destinations/verify/${token}`);
  smtp.sent.length = 0;
  const a = (await admin.post("/v1/addresses", { site_name: "Shop", domain: DOMAIN })).json.address;
  await admin.patch(`/v1/addresses/${a.id}`, { forward_enabled: true, destination_id: dest.id });
  return a as { id: string; email: string };
}

describe("IMAP domains: creation", () => {
  it("refuses without APP_SECRET", async () => {
    const t = makeTestApp({}, { mail: fakeMail().clients });
    const admin = await setupAdmin(t);
    const r = await admin.post("/v1/domains", { name: DOMAIN, transport: "imap", mailbox: mailbox() });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("APP_SECRET");
    expect(t.deps.db.select().from(domains).all()).toEqual([]);
  });

  it("stores passwords encrypted, hides them, tests the connection and leaves Cloudflare alone", async () => {
    const { t, admin, imap, smtp } = await setup();
    const d = await addImapDomain(admin, { smtp_password: "smtp-pass" });
    expect(d.transport).toBe("imap");
    expect(d.status).toBe("active");
    expect(d.cf_zone_id).toBe(null);
    expect(JSON.stringify(d)).not.toContain("imap-pass");
    expect(d.mailbox).toMatchObject({
      has_imap_password: true,
      has_smtp_password: true,
      imap_folder: "INBOX",
      imap_done_folder: "Processed",
    });
    expect(imap.logins).toHaveLength(1);
    expect(smtp.verified).toBe(1);
    expect((t.cf as unknown as { zones: Map<string, unknown> }).zones.size).toBe(0);

    const row = mailboxRow(t);
    expect(row.imapPasswordEnc).not.toContain("imap-pass");
    expect(decryptSecret(APP_SECRET, row.imapPasswordEnc)).toBe("imap-pass");
    expect(decryptSecret(APP_SECRET, row.smtpPasswordEnc!)).toBe("smtp-pass");
    const listed = (await admin.get("/v1/domains")).json.domains[0];
    expect(JSON.stringify(listed)).not.toMatch(/pass"|imap-pass|smtp-pass|v1:/);
  });

  it("reports a failed login as an error and re-tests after an edit (empty password keeps the old one)", async () => {
    const { t, admin, imap } = await setup();
    imap.password = "other";
    const d = await addImapDomain(admin);
    expect(d.status).toBe("error");
    expect(d.status_detail).toContain("AUTHENTICATIONFAILED");

    imap.password = "imap-pass";
    const tested = (await admin.post(`/v1/domains/${d.id}/test`)).json.domain;
    expect(tested.status).toBe("active");

    const enc = mailboxRow(t).imapPasswordEnc;
    const edited = (await admin.patch(`/v1/domains/${d.id}`, { mailbox: mailbox({ imap_password: "", poll_seconds: 120 }) })).json.domain;
    expect(edited.mailbox.poll_seconds).toBe(120);
    expect(mailboxRow(t).imapPasswordEnc).toBe(enc);
  });

  it("reports a missing folder", async () => {
    const { admin } = await setup();
    const d = await addImapDomain(admin, { imap_folder: "Nope" });
    expect(d.status).toBe("error");
    expect(d.status_detail).toContain("Nope");
  });

  it("works without any Cloudflare credentials", async () => {
    const { t, admin } = await setup({ cf: "unconfigured" });
    const d = await addImapDomain(admin);
    expect(d.status).toBe("active");
    expect((await admin.get("/v1/admin/health")).json.domains[0]).toMatchObject({ transport: "imap", last_poll_error: null });
    expect((await admin.del(`/v1/domains/${d.id}`)).status).toBe(200);
    expect(t.deps.db.select().from(domainMailboxes).all()).toEqual([]);
  });
});

describe("IMAP domains: polling", () => {
  it("ingests mail, moves it to the done folder and records the poll", async () => {
    const { t, admin, imap } = await setup();
    await addImapDomain(admin);
    const a = (await admin.post("/v1/addresses", { site_name: "Shop", domain: DOMAIN })).json.address;
    imap.deliver(mail(a.email, { subject: "Code" }));

    expect(await poll(t)).toEqual({ processed: 1, skipped: 0 });
    const stored = t.deps.db.select().from(messages).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.envelopeTo).toBe(a.email);
    expect(imap.uids("INBOX")).toEqual([]);
    expect(imap.folders.get("Processed")).toHaveLength(1);
    expect(mailboxRow(t)).toMatchObject({ lastUid: 1, uidValidity: 1, lastPollError: null });
    expect(mailboxRow(t).lastPollAt).toBeTypeOf("number");
    expect(domainRow(t).lastIngestAt).toBeTypeOf("number");
    expect(renderPrometheus([])).toMatch(/throwaway_imap_polls_total\{domain="imap.example.test",result="ok"\} \d+/);
  });

  it("prefers envelope headers over To and deletes when no done folder is set", async () => {
    const { t, admin, imap } = await setup();
    await addImapDomain(admin, { imap_done_folder: null });
    const a = (await admin.post("/v1/addresses", { site_name: "Shop", domain: DOMAIN })).json.address;
    imap.deliver(mail("list@lists.example", { headers: [`Delivered-To: catchall@provider.example`, `X-Original-To: ${a.email}`] }));
    await poll(t);
    expect(t.deps.db.select().from(messages).all()).toHaveLength(1);
    expect([...imap.folders.keys()]).toEqual(["INBOX"]);
    expect(imap.uids()).toEqual([]);
  });

  it("leaves mail for other domains in place and does not look at it again", async () => {
    const { t, admin, imap } = await setup();
    await addImapDomain(admin);
    imap.deliver(mail("friend@personal.example"));
    expect(await poll(t)).toEqual({ processed: 0, skipped: 1 });
    expect(await poll(t)).toEqual({ processed: 0, skipped: 0 });
    expect(imap.uids()).toEqual([1]);
    expect(t.deps.db.select().from(messages).all()).toEqual([]);
  });

  it("forwards the raw message over SMTP to verified destinations", async () => {
    const { t, admin, imap, smtp } = await setup();
    await addImapDomain(admin);
    const a = await forwardingAddress(t, admin, smtp);
    const raw = mail(a.email, { subject: "Forward me" });
    imap.deliver(raw);
    await poll(t);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ from: "catchall@provider.example", to: ["me@personal.example"], raw });
    expect(smtp.sent[0]!.settings).toMatchObject({
      host: "smtp.provider.example",
      user: "catchall@provider.example",
      password: "imap-pass",
    });
  });

  it("does not forward rejected mail", async () => {
    const { t, admin, imap, smtp } = await setup();
    await addImapDomain(admin);
    imap.deliver(mail(`nobody@${DOMAIN}`));
    expect(await poll(t)).toEqual({ processed: 1, skipped: 0 });
    expect(smtp.sent).toEqual([]);
    expect(t.deps.db.select().from(messages).all()).toEqual([]);
  });

  it("retries a temporary SMTP failure on the next poll, skips a permanent one", async () => {
    const { t, admin, imap, smtp } = await setup();
    await addImapDomain(admin);
    const a = await forwardingAddress(t, admin, smtp);
    imap.deliver(mail(a.email, { messageId: "<one@example.com>" }));
    smtp.failWith = new SmtpError("421 try later", false);
    await expect(poll(t)).rejects.toThrow("421");
    expect(mailboxRow(t)).toMatchObject({ lastUid: 0, lastPollError: "SMTP: 421 try later" });
    expect(imap.uids()).toEqual([1]);

    smtp.failWith = null;
    await poll(t);
    expect(smtp.sent).toHaveLength(1);
    expect(t.deps.db.select().from(messages).all()).toHaveLength(1);
    expect(mailboxRow(t).lastPollError).toBe(null);

    const second = imap.deliver(mail(a.email, { messageId: "<two@example.com>" }));
    smtp.failWith = new SmtpError("550 no such user", true);
    expect(await poll(t)).toEqual({ processed: 1, skipped: 0 });
    expect(mailboxRow(t).lastUid).toBe(second);
  });

  it("saves last_uid after each message: a crash mid-poll never processes a mail twice", async () => {
    const { t, admin, imap } = await setup();
    await addImapDomain(admin, { imap_done_folder: "" });
    const a = (await admin.post("/v1/addresses", { site_name: "Shop", domain: DOMAIN })).json.address;
    imap.deliver(mail(a.email, { subject: "first" }));
    imap.deliver(mail(a.email, { subject: "second" }));
    // Pretend the delete of processed mail is impossible: the second poll must still skip uid 1.
    const kept = imap.folders.get("INBOX")!.slice();
    imap.failAfterFetches = 1;
    await expect(poll(t)).rejects.toThrow("connection lost");
    expect(mailboxRow(t).lastUid).toBe(1);
    imap.folders.set("INBOX", kept);
    imap.failAfterFetches = Infinity;
    await poll(t);
    expect(
      t.deps.db
        .select({ s: messages.subject })
        .from(messages)
        .all()
        .map((m) => m.s)
        .sort(),
    ).toEqual(["first", "second"]);
  });

  it("starts over when UIDVALIDITY changes", async () => {
    const { t, admin, imap } = await setup();
    await addImapDomain(admin);
    imap.deliver(mail("friend@personal.example"));
    await poll(t);
    expect(mailboxRow(t).lastUid).toBe(1);
    const a = (await admin.post("/v1/addresses", { site_name: "Shop", domain: DOMAIN })).json.address;
    imap.renumber();
    imap.deliver(mail(a.email));
    expect(await poll(t)).toEqual({ processed: 1, skipped: 1 });
    expect(mailboxRow(t)).toMatchObject({ uidValidity: 2, lastUid: 3 });
  });
});

describe("destinations verified by the app", () => {
  it("e-mails a one-time link through the IMAP domain's SMTP server when Cloudflare is not configured", async () => {
    const { t, admin, smtp } = await setup({ cf: "unconfigured" });
    const none = (await admin.post("/v1/destinations", { email: "early@personal.example" })).json.destination;
    expect(none.last_error).toContain("IMAP domain");
    expect(none.verification).toBe("app");

    await addImapDomain(admin);
    const d = (await admin.post("/v1/destinations", { email: "me@personal.example" })).json.destination;
    expect(d).toMatchObject({ verified: false, verification: "app", last_error: null });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ to: ["me@personal.example"], from: "catchall@provider.example" });
    const token = /http:\/\/localhost:3000\/v1\/destinations\/verify\/([\w-]+)/.exec(smtp.sent[0]!.raw)![1]!;

    expect((await t.app.request("/v1/destinations/verify/wrong")).headers.get("location")).toBe("/destinations?verified=0");
    const ok = await t.app.request(`/v1/destinations/verify/${token}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/destinations?verified=1");
    expect((await admin.get("/v1/destinations")).json.destinations.find((x: { id: string }) => x.id === d.id).verified).toBe(true);
    // Single use.
    expect((await t.app.request(`/v1/destinations/verify/${token}`)).headers.get("location")).toBe("/destinations?verified=0");
  });

  it("expires links after 48 hours; resend issues a new one", async () => {
    const { t, admin, smtp } = await setup();
    await addImapDomain(admin);
    let now = Date.now();
    t.deps.now = () => now;
    const d = (await admin.post("/v1/destinations", { email: "me@personal.example", verify_by: "app" })).json.destination;
    const first = /verify\/([\w-]+)/.exec(smtp.sent[0]!.raw)![1];
    now += 49 * 3600_000;
    expect((await t.app.request(`/v1/destinations/verify/${first}`)).headers.get("location")).toBe("/destinations?verified=0");
    await admin.post(`/v1/destinations/${d.id}/resend`);
    const second = /verify\/([\w-]+)/.exec(smtp.sent[1]!.raw)![1];
    expect((await t.app.request(`/v1/destinations/verify/${second}`)).headers.get("location")).toBe("/destinations?verified=1");
  });

  it("keeps the Cloudflare flow when Cloudflare is configured", async () => {
    const { admin, smtp } = await setup();
    await addImapDomain(admin);
    const d = (await admin.post("/v1/destinations", { email: "me@personal.example" })).json.destination;
    expect(d.verification).toBe("cloudflare");
    expect(smtp.sent).toEqual([]);
    expect((await admin.post(`/v1/destinations/${d.id}/refresh`)).json.destination.verified).toBe(true);
  });
});
