import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { fakeMail, SmtpError } from "../mail-fakes.js";
import { createSubmissionServer } from "../../app/server/services/submission.js";
import { loadConfig } from "../../app/server/config.js";

const RELAY = "smtps://relay-user:pw@smtp.relay.example:465";

async function setup(env: Record<string, string> = {}) {
  const fake = fakeMail();
  const t = makeTestApp({ SMTP_RELAY_URL: RELAY, SUBMISSION_ALLOW_INSECURE: "true", ...env }, { mail: fake.clients });
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const a = (await admin.post("/v1/addresses", { site_name: "Shop" })).json.address;
  return { t, admin, a, ...fake };
}

const servers: Array<{ close: (cb: () => void) => void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(server: ReturnType<typeof createSubmissionServer>) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.server.address() as AddressInfo).port;
}

const RAW = (from: string, to: string) =>
  [
    "Received: from laptop.home (1.2.3.4) by smtp.personal.example",
    "X-Originating-IP: [1.2.3.4]",
    "User-Agent: Thunderbird/128",
    `From: Shopper <${from}>`,
    `To: ${to}`,
    "Bcc: hidden@else.example",
    "Subject: Question about my order",
    "Message-ID: <abc@laptop.personal.example>",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Hello, where is my parcel?",
    "",
  ].join("\r\n");

describe("sending new mail from an alias", () => {
  it("refuses plain-text AUTH unless the development flag is set", () => {
    expect(() => loadConfig({ NODE_ENV: "test", SUBMISSION_PORT: "587" })).toThrow("SUBMISSION_TLS_CERT");
    expect(() => loadConfig({ NODE_ENV: "test", SUBMISSION_PORT: "465", SUBMISSION_TLS: "implicit" })).toThrow("implicit");
    expect(() => loadConfig({ NODE_ENV: "test", SUBMISSION_TLS_CERT: "/x.pem" })).toThrow("both");
    expect(loadConfig({ NODE_ENV: "test", SUBMISSION_PORT: "2587", SUBMISSION_ALLOW_INSECURE: "1" }).SUBMISSION_PORT).toBe(2587);
  });

  it("manages SMTP passwords", async () => {
    const { admin } = await setup();
    const created = await admin.post("/v1/sending/passwords", { name: "Thunderbird" });
    expect(created.status).toBe(201);
    expect(created.json.password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/);
    const info = (await admin.get("/v1/sending")).json;
    expect(info.passwords).toHaveLength(1);
    expect(JSON.stringify(info)).not.toContain(created.json.password);
    expect(info.submission).toEqual({ enabled: false });
    expect((await admin.del(`/v1/sending/passwords/${created.json.smtp_password.id}`)).status).toBe(200);
    expect((await admin.get("/v1/sending")).json.passwords[0].revoked_at).not.toBeNull();
  });

  it("composes a mail through the API, records the contact and fires message.sent", async () => {
    const { t, admin, a, smtp } = await setup();
    const r = await admin.post(`/v1/addresses/${a.id}/send`, {
      to: "bob@shop.com",
      subject: "Hello",
      text: "Is my order ready?",
      from_name: "Shopper",
    });
    expect(r.status).toBe(200);
    expect(r.json.sent).toMatchObject({ from: a.email, to: ["bob@shop.com"], via: "relay" });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ from: a.email, to: ["bob@shop.com"] });
    expect(smtp.sent[0]!.raw).toContain(`From: "Shopper" <${a.email}>`);
    expect(smtp.sent[0]!.raw).toContain("Is my order ready?");
    const contacts = (await admin.get(`/v1/addresses/${a.id}/contacts`)).json.contacts;
    expect(contacts.map((c: { email: string }) => c.email)).toEqual(["bob@shop.com"]);

    // The answer, sent to the alias, gets the contact's reply address once forwarding is on.
    const d = (await admin.post("/v1/destinations", { email: "me@personal.example" })).json.destination;
    await admin.post(`/v1/destinations/${d.id}/refresh`);
    await admin.patch(`/v1/addresses/${a.id}`, { forward_enabled: true, destination_id: d.id, replies_enabled: true });
    const res = (await ingest(t, a.email, simpleEml({ text: "Yes", from: "bob@shop.com" }))).json;
    expect(Buffer.from(res.send[0].raw_base64, "base64").toString()).toContain(`<${contacts[0].reverse_address}>`);
  });

  it("refuses foreign aliases, inactive aliases and other users' contacts", async () => {
    const { t, admin, a, smtp } = await setup();
    const other = loginAs(t, "other@example.org");
    expect((await other.post(`/v1/addresses/${a.id}/send`, { to: "x@y.example", text: "hi" })).status).toBe(404);
    await admin.patch(`/v1/addresses/${a.id}`, { status: "paused" });
    expect((await admin.post(`/v1/addresses/${a.id}/send`, { to: "x@y.example", text: "hi" })).status).toBe(403);
    await admin.patch(`/v1/addresses/${a.id}`, { status: "active" });
    const b = (await admin.post("/v1/addresses", { site_name: "Other" })).json.address;
    await admin.post(`/v1/addresses/${b.id}/send`, { to: "z@z.example", text: "hi" });
    const contact = (await admin.get(`/v1/addresses/${b.id}/contacts`)).json.contacts[0];
    const r = await admin.post(`/v1/addresses/${a.id}/send`, { to: contact.reverse_address, text: "hi" });
    expect(r.status).toBe(403);
    // Through its own alias, the reverse address stands for the contact.
    const ok = await admin.post(`/v1/addresses/${b.id}/send`, { to: contact.reverse_address, text: "again" });
    expect(ok.json.sent.to).toEqual(["z@z.example"]);
    expect(smtp.sent.at(-1)!.to).toEqual(["z@z.example"]);
  });

  it("rate-limits per user and reports relay failures", async () => {
    const { admin, a, smtp } = await setup({ SEND_RATE_LIMIT_PER_HOUR: "2" });
    smtp.failWith = new SmtpError("550 relay denied", true);
    expect((await admin.post(`/v1/addresses/${a.id}/send`, { to: "x@y.example", text: "1" })).status).toBe(502);
    smtp.failWith = null;
    expect((await admin.post(`/v1/addresses/${a.id}/send`, { to: "x@y.example", text: "2" })).status).toBe(200);
    const r = await admin.post(`/v1/addresses/${a.id}/send`, { to: "x@y.example", text: "3" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("is unavailable without an outbound server", async () => {
    const { admin, a } = await setup({ SMTP_RELAY_URL: "" });
    expect((await admin.post(`/v1/addresses/${a.id}/send`, { to: "x@y.example", text: "1" })).status).toBe(503);
  });

  it("accepts mail over SMTP submission and strips identifying headers", async () => {
    const { t, admin, a, smtp } = await setup();
    const { password } = (await admin.post("/v1/sending/passwords", { name: "Phone" })).json;
    const port = await listen(createSubmissionServer(t.deps));
    const client = (pass: string) =>
      nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, auth: { user: "admin@example.org", pass } });

    await expect(client("wrong-password").verify()).rejects.toThrow(/535/);
    const info = await client(password).sendMail({
      envelope: { from: a.email, to: ["bob@shop.com", "hidden@else.example"] },
      raw: RAW(a.email, "Bob <bob@shop.com>"),
    });
    expect(info.response).toContain("Queued");
    const sent = smtp.sent.at(-1)!;
    expect(sent.to).toEqual(["bob@shop.com", "hidden@else.example"]);
    expect(sent.raw).toContain(`From: "Shopper" <${a.email}>`);
    expect(sent.raw).toContain("To: Bob <bob@shop.com>");
    expect(sent.raw).toContain("Hello, where is my parcel?");
    for (const leak of ["Received:", "1.2.3.4", "Thunderbird", "laptop", "Bcc:", "hidden@else.example>"])
      expect(sent.raw).not.toContain(leak);

    // From must be an alias of the signed-in user.
    await expect(
      client(password).sendMail({
        envelope: { from: "me@gmail.example", to: ["bob@shop.com"] },
        raw: RAW("me@gmail.example", "bob@shop.com"),
      }),
    ).rejects.toThrow(/553/);
  });

  it("requires TLS before AUTH when a certificate is configured", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-smtp-"));
    try {
      execFileSync(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1"].concat([
          "-keyout",
          path.join(dir, "key.pem"),
          "-out",
          path.join(dir, "cert.pem"),
        ]),
        { stdio: "ignore" },
      );
    } catch {
      return; // no openssl on this machine
    }
    const { t, admin, a, smtp } = await setup({ SUBMISSION_ALLOW_INSECURE: "" });
    const { password } = (await admin.post("/v1/sending/passwords", { name: "Phone" })).json;
    const port = await listen(
      createSubmissionServer(t.deps, {
        key: fs.readFileSync(path.join(dir, "key.pem")),
        cert: fs.readFileSync(path.join(dir, "cert.pem")),
      }),
    );
    const auth = { user: "admin@example.org", pass: password };
    await expect(nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, auth }).verify()).rejects.toThrow();
    await nodemailer
      .createTransport({ host: "127.0.0.1", port, secure: false, requireTLS: true, tls: { rejectUnauthorized: false }, auth })
      .sendMail({ envelope: { from: a.email, to: ["bob@shop.com"] }, raw: RAW(a.email, "bob@shop.com") });
    expect(smtp.sent).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
