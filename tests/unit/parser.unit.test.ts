import { describe, expect, it } from "vitest";
import { parseMessage, unwrapRedirect, htmlToText, runParser, type ParserStrategy } from "../../app/server/parser/index.js";

const code = (text: string, subject = "") => parseMessage({ subject, text }).code?.value ?? null;

describe("code extraction", () => {
  it("finds a code next to an English keyword", () => expect(code("Your verification code is 123456.")).toBe("123456"));
  it("finds a code before a keyword", () => expect(code("123456 is your one-time passcode")).toBe("123456"));
  it("finds a French code", () => expect(code("Votre code de vérification : 908172")).toBe("908172"));
  it("rejects years", () => expect(code("Copyright 2024 – thanks for being with us since 2019")).toBeNull());
  it("rejects phone numbers", () => expect(code("Call us: +33 1 23 45 67 89 for help with your account")).toBeNull());
  it("rejects amounts", () => expect(code("Your code purchase total is $1299 and €4500")).toBeNull());
  it("rejects order numbers", () => expect(code("Order #482913 confirmed. Order number: 557812")).toBeNull());
  it("rejects zip codes", () => expect(code("Sent from 75011 Paris and Springfield, IL 62704")).toBeNull());
  it("does not offer street numbers as alternatives", () => {
    const r = parseMessage({ text: "Your verification code: 482910\nX Corp. 1355 Market Street, Suite 900\n10 rue de Rivoli, Paris" });
    expect(r.code?.value).toBe("482910");
    expect(r.alternatives.map((a) => a.value)).not.toContain("1355");
  });
  it("ignores digits inside URLs and e-mails", () => expect(code("Visit https://x.com/a/123456 or mail 654321@x.com")).toBeNull());
  it("ignores hidden HTML preheaders", () => {
    const html = `<div style="display:none">code 111111</div><p>Your code is <b>222222</b></p>`;
    expect(parseMessage({ html }).code?.value).toBe("222222");
  });
  it("prefers the keyword-adjacent candidate over others", () => {
    const r = parseMessage({ text: "Ticket 4821 opened.\nYour login code: 739201\nValid 10 minutes." });
    expect(r.code?.value).toBe("739201");
  });
  it("returns alternatives with confidence", () => {
    const r = parseMessage({ text: "Your code: 739201\nBackup code: 112233" });
    expect(r.code?.value).toBe("739201");
    expect(r.alternatives.map((a) => a.value)).toContain("112233");
    expect(r.code!.confidence).toBeGreaterThan(r.alternatives[0]!.confidence - 0.0001);
  });
});

describe("links", () => {
  it("unwraps redirect params", () => {
    expect(unwrapRedirect("https://t.example.com/c?url=https%3A%2F%2Fapp.io%2Fverify%3Ft%3D1")).toBe("https://app.io/verify?t=1");
    expect(unwrapRedirect("https://www.google.com/url?q=https://a.io/confirm&sa=D")).toBe("https://a.io/confirm");
  });
  it("leaves normal links alone", () => expect(unwrapRedirect("https://a.io/x?y=1")).toBe("https://a.io/x?y=1"));
  it("skips unsubscribe links", () => {
    const r = parseMessage({ text: "Unsubscribe https://a.io/unsubscribe?token=abcdefghijkl" });
    expect(r.links).toEqual([]);
  });
});

describe("html to text", () => {
  it("drops style, script and hidden blocks", () => {
    const t = htmlToText(`<style>.a{}</style><script>x()</script><span style="display: none">hidden</span><p>Visible</p>`);
    expect(t).toBe("Visible");
  });
});

describe("strategies", () => {
  it("calls fallback strategies only when nothing is found", async () => {
    let called = 0;
    const s: ParserStrategy = {
      name: "fake",
      async extract(_i, base) {
        called++;
        return { ...base, code: { value: "999000", raw: "999000", confidence: 0.5, method: "fake" } };
      },
    };
    expect((await runParser({ text: "Your code is 123456" }, [s])).code?.value).toBe("123456");
    expect(called).toBe(0);
    const r = await runParser({ text: "nothing here" }, [s]);
    expect(r.code?.value).toBe("999000");
    expect(r.strategy).toBe("fake");
  });
});

describe("display sanitiser", async () => {
  const { sanitizeEmailHtml } = await import("../../app/server/lib/sanitize.js");
  it("removes scripts, handlers and titles, blocks remote images, keeps data images", () => {
    const out = sanitizeEmailHtml(
      `<html><head><title>T</title></head><body><script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">a</a><img src="https://tracker.example/p.gif"><img src="data:image/png;base64,AAAA"><form><input></form><iframe src="https://x"></iframe><p style="color:red">ok</p></body></html>`,
    );
    expect(out).not.toMatch(/script|onclick|javascript:|<form|<iframe|<input|>T</);
    expect(out).toContain('data-blocked-src="https://tracker.example/p.gif"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('<p style="color:red">ok</p>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe("authentication results", async () => {
  const { authResult } = await import("../../app/server/services/ingest/index.js");
  // Exactly what Cloudflare wrote for the test mail on 2026-11-01
  const cf = [
    {
      key: "authentication-results",
      value:
        "mx.cloudflare.net;\tdkim=pass header.d=gmail.com header.s=20260707 header.b=AbCdEf12;\tdmarc=pass header.from=gmail.com policy.dmarc=none;\tspf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-yw1-x1135.google.com) smtp.helo=mail-yw1-x1135.google.com;\tspf=pass (mx.cloudflare.net: domain of you@example.com designates 2607:f8b0:4864:20::1135 as permitted sender) smtp.mailfrom=you@example.com;\tarc=pass",
    },
  ];
  it("uses the MAIL FROM SPF result, not the HELO one", () => {
    expect(authResult(cf, "spf")).toBe("pass");
    expect(authResult(cf, "dkim")).toBe("pass");
    expect(authResult(cf, "dmarc")).toBe("pass");
  });
  it("still reads a single SPF clause", () => {
    expect(authResult([{ key: "authentication-results", value: "mx; spf=softfail smtp.helo=x" }], "spf")).toBe("softfail");
    expect(authResult([], "spf")).toBeNull();
  });
});
