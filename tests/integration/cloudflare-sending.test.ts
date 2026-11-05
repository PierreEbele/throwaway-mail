import { describe, expect, it } from "vitest";
import { addDomain, makeTestApp, setupAdmin } from "../helpers.js";
import { fakeMail } from "../mail-fakes.js";
import { loadConfig } from "../../app/server/config.js";
import { CloudflareError } from "../../app/server/cloudflare/index.js";
import { MockCloudflareClient } from "../../app/server/cloudflare/mock.js";
import { cloudflareTransport } from "../../app/server/services/transport.js";
import { SmtpError } from "../../app/server/services/mailbox/types.js";

async function setup(env: Record<string, string> = {}) {
  const fake = fakeMail();
  const t = makeTestApp({ OUTBOUND_TRANSPORT: "cloudflare", ...env }, { mail: fake.clients });
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const a = (await admin.post("/v1/addresses", { site_name: "Shop" })).json.address;
  return { t, admin, a, ...fake };
}

describe("Cloudflare Email Sending transport", () => {
  it("defaults to SMTP and needs Cloudflare credentials when selected", () => {
    expect(loadConfig({ NODE_ENV: "test" }).OUTBOUND_TRANSPORT).toBe("smtp");
    expect(() => loadConfig({ NODE_ENV: "test", OUTBOUND_TRANSPORT: "cloudflare" })).toThrow("CF_API_TOKEN");
    expect(loadConfig({ NODE_ENV: "test", OUTBOUND_TRANSPORT: "cloudflare", CF_MOCK: "1" }).OUTBOUND_TRANSPORT).toBe("cloudflare");
  });

  it("sends composed mail through Email Sending, not SMTP, with the alias as envelope sender", async () => {
    const { t, admin, a, smtp } = await setup({
      SMTP_RELAY_URL: "smtps://u:p@smtp.relay.example:465",
      SMTP_RELAY_FROM: "bounce@relay.example",
    });
    const r = await admin.post(`/v1/addresses/${a.id}/send`, { to: "bob@shop.com", subject: "Hello", text: "Is my order ready?" });
    expect(r.status).toBe(200);
    expect(r.json.sent).toMatchObject({ from: a.email, to: ["bob@shop.com"], via: "relay" });
    expect(smtp.sent).toHaveLength(0);
    expect(t.cf.sent).toHaveLength(1);
    expect(t.cf.sent[0]).toMatchObject({ from: a.email, recipients: ["bob@shop.com"] });
    expect(t.cf.sent[0]!.mime).toContain("Is my order ready?");
  });

  it("reports a permanent bounce as a failed send", async () => {
    const { admin, a } = await setup();
    const r = await admin.post(`/v1/addresses/${a.id}/send`, { to: "bounce@shop.com", text: "hi" });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("maps API errors to permanent or temporary failures", async () => {
    const cf = new MockCloudflareClient();
    const raw = Buffer.from("Subject: x\r\n\r\nx");
    await expect(cloudflareTransport(cf).send({ from: "a@unverified.example", to: ["b@c.example"] }, raw)).rejects.toMatchObject({
      permanent: true,
    });
    cf.sendRawEmail = async () => {
      throw new CloudflareError("throttled", 429, 10004);
    };
    const e = await cloudflareTransport(cf)
      .send({ from: "a@b.example", to: ["b@c.example"] }, raw)
      .catch((x) => x);
    expect(e).toBeInstanceOf(SmtpError);
    expect(e.permanent).toBe(false);
  });
});
