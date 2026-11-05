import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import { addDomain, makeTestApp, setupAdmin } from "../helpers.js";
import { fakeMail, SmtpError } from "../mail-fakes.js";
import { checkSmtpLogin, createSmtpPassword, createSubmissionServer, startSubmission } from "../../app/server/services/submission.js";
import { smtpPasswords, users } from "../../app/server/db/schema.js";

const RELAY = "smtps://relay-user:pw@smtp.relay.example:465";

async function setup(env: Record<string, string> = {}) {
  const fake = fakeMail();
  const t = makeTestApp({ SMTP_RELAY_URL: RELAY, SUBMISSION_ALLOW_INSECURE: "true", ...env }, { mail: fake.clients });
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const a = (await admin.post("/v1/addresses", { site_name: "Shop" })).json.address;
  const user = t.deps.db.select().from(users).where(eq(users.email, "admin@example.org")).get()!;
  return { t, admin, a, user, ...fake };
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

const transport = (port: number, user: string, pass: string) =>
  nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, auth: { user, pass } });

const raw = (from: string, to: string) =>
  [`From: ${from}`, `To: ${to}`, "Subject: Hi", "Message-ID: <x@client.example>", "", "Hello", ""].join("\r\n");

describe("SMTP submission", () => {
  it("is not started without SUBMISSION_PORT", async () => {
    const { t } = await setup();
    expect(startSubmission(t.deps)).toBeNull();
  });

  it("checks e-mail and password, case-insensitively, and refuses revoked passwords and disabled users", async () => {
    const { t, user } = await setup();
    const { password, row } = createSmtpPassword(t.deps, user.id, "Laptop");
    expect(password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/);
    expect(row.hint).toBe(password.slice(0, 4));
    expect(checkSmtpLogin(t.deps, " ADMIN@example.org ", ` ${password} `)?.id).toBe(user.id);
    expect(t.deps.db.select().from(smtpPasswords).where(eq(smtpPasswords.id, row.id)).get()!.lastUsedAt).not.toBeNull();
    expect(checkSmtpLogin(t.deps, "admin@example.org", "nope")).toBeNull();
    expect(checkSmtpLogin(t.deps, "nobody@example.org", password)).toBeNull();

    t.deps.db.update(users).set({ disabled: true }).where(eq(users.id, user.id)).run();
    expect(checkSmtpLogin(t.deps, "admin@example.org", password)).toBeNull();
    t.deps.db.update(users).set({ disabled: false }).where(eq(users.id, user.id)).run();

    t.deps.db.update(smtpPasswords).set({ revokedAt: Date.now() }).where(eq(smtpPasswords.id, row.id)).run();
    expect(checkSmtpLogin(t.deps, "admin@example.org", password)).toBeNull();
  });

  it("locks an account out after repeated failures", async () => {
    const { t, admin } = await setup({ LOGIN_MAX_FAILURES: "2" });
    const { password } = (await admin.post("/v1/sending/passwords", { name: "Phone" })).json;
    const port = await listen(createSubmissionServer(t.deps));
    await expect(transport(port, "admin@example.org", "bad-1").verify()).rejects.toThrow(/535/);
    await expect(transport(port, "admin@example.org", "bad-2").verify()).rejects.toThrow(/535/);
    // Even the right password waits now.
    await expect(transport(port, "admin@example.org", password).verify()).rejects.toThrow(/454/);
  });

  it("caps the number of recipients per mail", async () => {
    const { t, admin, a, smtp } = await setup({ SEND_MAX_RECIPIENTS: "2" });
    const { password } = (await admin.post("/v1/sending/passwords", { name: "Phone" })).json;
    const port = await listen(createSubmissionServer(t.deps));
    // The third RCPT TO is refused with 452; the mail goes to the accepted ones.
    const info = await transport(port, "admin@example.org", password).sendMail({
      envelope: { from: a.email, to: ["a@x.example", "b@x.example", "c@x.example"] },
      raw: raw(a.email, "a@x.example"),
    });
    expect(info.rejected).toEqual(["c@x.example"]);
    expect(String((info as unknown as { rejectedErrors: Array<{ responseCode: number }> }).rejectedErrors[0]!.responseCode)).toBe("452");
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent.at(-1)!.to).toEqual(["a@x.example", "b@x.example"]);
  });

  it("maps relay failures to SMTP codes and records refused mail in the audit log", async () => {
    const { t, admin, a, smtp } = await setup();
    const { password } = (await admin.post("/v1/sending/passwords", { name: "Phone" })).json;
    const port = await listen(createSubmissionServer(t.deps));
    smtp.failWith = new SmtpError("550 relay denied", true);
    await expect(
      transport(port, "admin@example.org", password).sendMail({
        envelope: { from: a.email, to: ["a@x.example"] },
        raw: raw(a.email, "a@x.example"),
      }),
    ).rejects.toThrow(/554/);
    smtp.failWith = new SmtpError("421 try later", false);
    await expect(
      transport(port, "admin@example.org", password).sendMail({
        envelope: { from: a.email, to: ["a@x.example"] },
        raw: raw(a.email, "a@x.example"),
      }),
    ).rejects.toThrow(/451/);
    smtp.failWith = null;
    await expect(
      transport(port, "admin@example.org", password).sendMail({
        envelope: { from: "me@gmail.example", to: ["a@x.example"] },
        raw: raw("me@gmail.example", "a@x.example"),
      }),
    ).rejects.toThrow(/553/);
    const log = (await admin.get("/v1/admin/audit")).json;
    expect(JSON.stringify(log)).toContain("mail.refused");
  });
});
