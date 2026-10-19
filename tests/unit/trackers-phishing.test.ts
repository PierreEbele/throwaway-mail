import { describe, expect, it } from "vitest";
import { sanitizeEmail } from "../../app/server/lib/sanitize.js";
import { cleanLink, isTrackingPixel } from "../../app/server/lib/trackers.js";
import { authWarning, isLookalike, skeleton } from "../../app/server/lib/phishing.js";
import { listInfo } from "../../app/server/lib/listheaders.js";

describe("trackers", () => {
  it("detects pixels but keeps real images", () => {
    expect(isTrackingPixel({ src: "https://x.com/a.gif", width: "1", height: "1" })).toBe(true);
    expect(isTrackingPixel({ src: "https://x.com/a.gif", style: "display:none" })).toBe(true);
    expect(isTrackingPixel({ src: "https://shop.com/wf/open?upn=abc" })).toBe(true);
    expect(isTrackingPixel({ src: "https://ct.sendgrid.net/x/y" })).toBe(true);
    expect(isTrackingPixel({ src: "https://shop.com/logo.png", width: "120", height: "40" })).toBe(false);
  });

  it("strips tracking parameters only", () => {
    expect(cleanLink("https://shop.com/p?id=4&utm_source=nl&utm_medium=email&fbclid=x")).toEqual({ url: "https://shop.com/p?id=4", changed: true });
    expect(cleanLink("https://shop.com/p?id=4").changed).toBe(false);
    expect(cleanLink("mailto:a@b.c").changed).toBe(false);
  });

  it("counts what it removed", () => {
    const r = sanitizeEmail('<p><a href="https://s.com/?utm_campaign=x">Go</a><img src="https://t.com/p.gif" width="1" height="1"><img src="https://s.com/hero.jpg"></p>');
    expect(r.trackers).toBe(2);
    expect(r.html).not.toContain("t.com/p.gif");
    expect(r.html).toContain('href="https://s.com/"');
    expect(r.html).toContain("data-blocked-src=\"https://s.com/hero.jpg\"");
  });
});

describe("phishing", () => {
  it("spots look-alike domains", () => {
    expect(skeleton("paypa1")).toBe("paypal");
    expect(isLookalike("https://paypal.com", "service@paypa1.com")).toBe(true);
    expect(isLookalike("https://paypal.com", "a@paypal-secure-login.com")).toBe(true);
    expect(isLookalike("https://github.com", "a@githuh.com")).toBe(true);
    expect(isLookalike("https://paypal.com", "a@mail.paypal.com")).toBe(false);
    expect(isLookalike("https://paypal.com", "a@ebay.com")).toBe(false);
  });

  it("flags failed authentication", () => {
    const none = { spf: null, dkim: null, dmarc: null };
    expect(authWarning(null, "a@x.com", { ...none, dmarc: "fail" })).toBe("auth_failed");
    expect(authWarning(null, "a@x.com", { spf: "fail", dkim: "fail", dmarc: null })).toBe("auth_failed");
    expect(authWarning(null, "a@x.com", { spf: "fail", dkim: "pass", dmarc: "pass" })).toBe(null);
  });
});

describe("list headers", () => {
  it("parses List-Unsubscribe and bulk markers", () => {
    const h = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));
    expect(listInfo(h({ "list-unsubscribe": "<mailto:u@x.com>, <https://x.com/u?id=1>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" }))).toEqual({
      url: "https://x.com/u?id=1",
      mailto: "mailto:u@x.com",
      oneClick: true,
      bulk: true,
    });
    expect(listInfo(h({ precedence: "bulk" })).bulk).toBe(true);
    expect(listInfo(h({ subject: "hi" }))).toEqual({ url: null, mailto: null, oneClick: false, bulk: false });
  });
});
