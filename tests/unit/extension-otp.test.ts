import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// extension/otp.js runs as a content script in Firefox and Chrome; here it runs on plain objects shaped like inputs.
const ctx: any = {};
ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../extension/otp.js"), "utf8"), ctx);
const Otp = ctx.ThrowawayOtp;

type Fake = {
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  inputMode?: string;
  maxLength?: number;
  readOnly?: boolean;
  disabled?: boolean;
  form?: object | null;
  attrs?: Record<string, string>;
  value?: string;
};
const input = (f: Fake) => ({
  type: "text",
  name: "",
  id: "",
  placeholder: "",
  autocomplete: "",
  inputMode: "",
  maxLength: -1,
  readOnly: false,
  disabled: false,
  form: null,
  value: "",
  ...f,
  getAttribute(k: string) {
    return f.attrs?.[k] ?? null;
  },
});
const boxes = (n: number, extra: Fake = {}, form: object = {}) =>
  Array.from({ length: n }, (_, i) => input({ maxLength: 1, inputMode: "numeric", name: `d${i}`, form, ...extra }));
const set = (el: { value: string }, v: string) => (el.value = v);

describe("extension one-time-code detection", () => {
  it('finds autocomplete="one-time-code" first', () => {
    const otp = input({ autocomplete: "one-time-code", name: "x" });
    const r = Otp.otpField([input({ type: "email", name: "email" }), input({ name: "promo" }), otp]);
    expect(r.el).toBe(otp);
  });

  it("finds hinted names and ids but not promo, postal or card fields", () => {
    for (const f of [{ name: "otp" }, { id: "verification-code" }, { name: "mfa_token" }, { placeholder: "Enter code" }, { name: "pin" }]) {
      const el = input(f);
      expect(Otp.otpField([el]).el).toBe(el);
    }
    for (const f of [
      { name: "promo_code" },
      { name: "postal_code" },
      { id: "zipcode" },
      { name: "coupon" },
      { name: "card_code" },
      { name: "verify_code", maxLength: 2 },
      { name: "password_confirm", type: "password" },
    ])
      expect(Otp.otpField([input(f)])).toBeNull();
  });

  it("finds a numeric 4-8 character field with no hint", () => {
    const el = input({ name: "field7", inputMode: "numeric", maxLength: 6 });
    expect(Otp.otpField([input({ name: "first" }), el]).el).toBe(el);
    expect(Otp.otpField([input({ name: "field7", maxLength: 6 })])).toBeNull(); // not numeric
  });

  it("finds split boxes (4 to 8 one-digit inputs of one form)", () => {
    const six = boxes(6);
    expect(Otp.otpField([input({ type: "email" }), ...six]).boxes).toEqual(six);
    // autocomplete="one-time-code" on the first box only still means the whole group.
    const tagged = boxes(6, { inputMode: "" });
    tagged[0]!.autocomplete = "one-time-code";
    expect(Otp.otpField(tagged).boxes).toHaveLength(6);
    expect(Otp.otpField(boxes(3))).toBeNull();
    expect(Otp.otpField(boxes(9))).toBeNull();
    // One-letter text boxes are not a code in strict mode, but are filled once a code is expected.
    const letters = boxes(6, { inputMode: "" });
    expect(Otp.otpField(letters)).toBeNull();
    expect(Otp.codeTarget(letters, 6).boxes).toHaveLength(6);
    // Two groups: the one in a complete group is used.
    const other = boxes(2, {}, {});
    expect(Otp.otpField([...other, ...six]).boxes).toEqual(six);
  });

  it("ignores read-only, disabled and non-text inputs", () => {
    expect(Otp.otpField([input({ name: "otp", readOnly: true })])).toBeNull();
    expect(Otp.otpField([input({ name: "otp", disabled: true })])).toBeNull();
    expect(Otp.otpField([input({ name: "otp", type: "hidden" })])).toBeNull();
  });

  it("falls back to the focused field once a code is expected", () => {
    const focused = input({ name: "answer" });
    expect(Otp.codeTarget([focused], 6, null)).toBeNull();
    expect(Otp.codeTarget([focused], 6, focused).el).toBe(focused);
    expect(Otp.codeTarget([focused], 6, input({ name: "elsewhere" }))).toBeNull();
  });

  it("fills a single field or one character per box", () => {
    const el = input({ name: "otp" });
    expect(Otp.fill({ el }, "482913", set)).toBe(true);
    expect(el.value).toBe("482913");
    const six = boxes(6);
    expect(Otp.fill({ boxes: six }, "482913", set)).toBe(true);
    expect(six.map((b) => b.value).join("")).toBe("482913");
    const four = boxes(4);
    Otp.fill({ boxes: four }, "482913", set);
    expect(four.map((b) => b.value).join("")).toBe("4829");
    expect(Otp.fill(null, "1", set)).toBe(false);
  });

  it("is loaded before the content script in both builds", async () => {
    const firefox = JSON.parse(fs.readFileSync(path.join(__dirname, "../../extension/manifest.json"), "utf8"));
    const { chromeManifest } = await import(path.join(__dirname, "../../scripts/chrome-manifest.mjs"));
    for (const m of [firefox, chromeManifest(firefox)]) {
      const js: string[] = m.content_scripts[0].js;
      expect(js.indexOf("otp.js")).toBeGreaterThan(js.indexOf("compat.js"));
      expect(js.indexOf("otp.js")).toBeLessThan(js.indexOf("content.js"));
    }
  });
});
