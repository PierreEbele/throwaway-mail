"use strict";
// One-time-code field detection and filling, shared by the content script and the unit tests.
// Pure functions over input elements (or objects with the same properties): no DOM queries here.
(() => {
  const NON_TEXT = ["hidden", "password", "email", "checkbox", "radio", "submit", "button", "file", "image", "reset", "range", "color"];
  // Name / id / placeholder / label hints of a code field.
  const STRICT_HINT = /\b(otp|totp|2fa|mfa)\b|one.?time|verif|(^|[^a-z])(pin|code)([^a-z]|$)|security.?code|auth.?code|passcode|token/i;
  const LOOSE_HINT = /code|otp|token|verif|pin|2fa|mfa|one.?time|confirm/i;
  // Fields that look like codes but are not one-time codes.
  const NOT_OTP =
    /promo|coupon|voucher|discount|postal|zip|post.?code|gift|referr|invite|captcha|country|area|phone|tel(ephone)?\b|iban|swift|sort.?code|cvc|cvv|card/i;

  const attr = (el, k) => (typeof el.getAttribute === "function" ? el.getAttribute(k) : el[k]) || "";
  const text = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${attr(el, "aria-label")} ${attr(el, "data-testid")}`;
  const ac = (el) => String(el.autocomplete || attr(el, "autocomplete")).toLowerCase();
  const numericish = (el) =>
    el.inputMode === "numeric" ||
    attr(el, "inputmode") === "numeric" ||
    attr(el, "pattern") === "[0-9]*" ||
    attr(el, "pattern") === "\\d*" ||
    el.type === "number" ||
    el.type === "tel";

  /** Inputs a code could be typed into (text-like, editable). */
  const textLike = (el) => !el.readOnly && !el.disabled && !NON_TEXT.includes(el.type || "text");

  /** A numeric field of 4 to 8 characters, with no hint in its name. */
  const isOtpShape = (el) => el.maxLength >= 4 && el.maxLength <= 8 && numericish(el);

  /**
   * Split code boxes: 4 to 8 one-character inputs in the same form (or the same parent), in page order.
   * `strict` also requires them to look numeric or be marked one-time-code.
   */
  function splitBoxes(inputs, strict) {
    const single = inputs.filter((el) => textLike(el) && el.maxLength === 1 && !NOT_OTP.test(text(el)));
    const groups = new Map();
    for (const el of single) {
      const key = el.form || el.parentElement?.parentElement || el.parentElement || "page";
      (groups.get(key) || groups.set(key, []).get(key)).push(el);
    }
    for (const g of groups.values()) {
      if (g.length < 4 || g.length > 8) continue;
      const marked = g.some((el) => ac(el) === "one-time-code");
      if (strict && !marked && !g.every((el) => numericish(el) || STRICT_HINT.test(text(el)))) continue;
      return g;
    }
    return null;
  }

  /**
   * Strict detection, to offer a code with no wait in progress: autocomplete="one-time-code", a hinted name that
   * is not a promo / postal / card field, a numeric 4-8 character field, or split boxes.
   * Returns { el } or { boxes } or null.
   */
  function otpField(inputs) {
    const fields = inputs.filter(textLike);
    const boxes = splitBoxes(fields, true);
    const tagged = fields.find((el) => ac(el) === "one-time-code");
    if (tagged) return boxes && boxes.includes(tagged) ? { boxes } : { el: tagged };
    if (boxes) return { boxes };
    const hinted = fields.find(
      (el) =>
        ["text", "number", "tel", "", undefined].includes(el.type) &&
        STRICT_HINT.test(text(el)) &&
        !NOT_OTP.test(text(el)) &&
        !(el.maxLength >= 0 && el.maxLength < 4),
    );
    if (hinted) return { el: hinted };
    const shaped = fields.find((el) => isOtpShape(el) && !NOT_OTP.test(text(el)));
    return shaped ? { el: shaped } : null;
  }

  /** Lenient detection, once a code is known to be expected: also the focused field and looser hints. */
  function codeTarget(inputs, len, focused) {
    const fields = inputs.filter(textLike);
    const boxes = splitBoxes(fields, false);
    if (len > 1 && boxes && boxes.length >= len) return { boxes };
    const strict = otpField(fields);
    if (strict?.el) return strict;
    const el =
      fields.find((i) => LOOSE_HINT.test(text(i)) && !NOT_OTP.test(text(i))) || (focused && fields.includes(focused) ? focused : null);
    return el ? { el } : null;
  }

  /** Writes `code` into a target from otpField/codeTarget with `setValue(el, value)`; true when something was filled. */
  function fill(target, code, setValue) {
    if (!target || !code) return false;
    if (target.boxes) {
      const chars = String(code).split("");
      target.boxes.slice(0, chars.length).forEach((el, i) => setValue(el, chars[i]));
      return true;
    }
    setValue(target.el, String(code));
    return true;
  }

  const api = { otpField, codeTarget, splitBoxes, isOtpShape, fill };
  if (typeof globalThis !== "undefined") globalThis.ThrowawayOtp = api;
})();
