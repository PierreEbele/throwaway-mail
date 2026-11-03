import { describe, expect, it } from "vitest";
import { addressesIn, findRecipient, findSender } from "../../app/server/services/mailbox/recipient.js";

const raw = (...headers: string[]) => Buffer.from([...headers, "", "Body with To: fake@ours.example"].join("\r\n"));

describe("recipient detection", () => {
  it("prefers envelope headers to To / Cc", () => {
    const m = raw("To: other@ours.example", "Delivered-To: box@provider.example", "X-Original-To: alias@ours.example");
    expect(findRecipient(m, "ours.example")).toBe("alias@ours.example");
    expect(findRecipient(raw("Envelope-To: e@ours.example", "To: t@ours.example"), "ours.example")).toBe("e@ours.example");
    expect(findRecipient(raw("X-Envelope-To: <X@Ours.Example>"), "ours.example")).toBe("x@ours.example");
  });

  it("falls back to the first address of the domain in To, then Cc", () => {
    expect(findRecipient(raw('To: "Me" <me@else.example>, Shop <shop@ours.example>', "Cc: cc@ours.example"), "ours.example")).toBe(
      "shop@ours.example",
    );
    expect(findRecipient(raw("To: me@else.example", "Cc: cc@ours.example"), "ours.example")).toBe("cc@ours.example");
  });

  it("handles folded headers and ignores display names and the body", () => {
    expect(findRecipient(raw("To: a@else.example,", "\tb@ours.example"), "ours.example")).toBe("b@ours.example");
    expect(findRecipient(raw('To: "x@ours.example" <me@else.example>'), "ours.example")).toBe(null);
    expect(findRecipient(raw("To: me@else.example"), "ours.example")).toBe(null);
  });

  it("does not match sub-domains or look-alikes", () => {
    expect(findRecipient(raw("To: a@sub.ours.example, b@notours.example"), "ours.example")).toBe(null);
  });

  it("extracts the envelope sender from Return-Path, else From", () => {
    expect(findSender(raw("Return-Path: <bounce@shop.example>", "From: Shop <news@shop.example>"))).toBe("bounce@shop.example");
    expect(findSender(raw("From: Shop <news@shop.example>"))).toBe("news@shop.example");
    expect(findSender(raw("Subject: none"))).toBe("");
    expect(addressesIn("Shop (a@b.example) <c@d.example>")).toEqual(["c@d.example"]);
  });
});
