import { describe, expect, it } from "vitest";
import { ThrowawayMailError } from "../../sdk/src/index.js";
import { fakeMail } from "../mail-fakes.js";
import { sdkFixture } from "./setup.js";

describe("SDK: sending", () => {
  it("sends a new mail from an address", async () => {
    const fake = fakeMail();
    const { tm, calls } = await sdkFixture({ SMTP_RELAY_URL: "smtp://relay.example:587" }, { mail: fake.clients });
    const a = await tm.addresses.create({ siteName: "Shop" });
    const sent = await tm.addresses.send(a.id, { to: "bob@shop.com", subject: "Hi", text: "Hello", fromName: "Me" });
    expect(sent).toMatchObject({ address_id: a.id, from: a.email, to: ["bob@shop.com"], via: "relay" });
    expect(calls).toContain(`POST /v1/addresses/${a.id}/send`);
    expect(fake.smtp.sent[0]!.raw).toContain("Subject: Hi");
  });

  it("reports a missing outbound server", async () => {
    const { tm } = await sdkFixture();
    const a = await tm.addresses.create({ siteName: "Shop" });
    const err = await tm.addresses.send(a.id, { to: "bob@shop.com", text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ThrowawayMailError);
    expect(err.status).toBe(503);
  });
});
