import { describe, expect, it } from "vitest";
import { extractCodes, parseMessage, MAX_PARSE_CHARS, boundedInput } from "../../app/server/parser/index.js";
import { unsubscribeCandidates } from "../../app/server/parser/unsubscribe.js";

/** Bodies shaped to make a backtracking or per-match rescan blow up. */
const LARGE_TEXTS: Record<string, string> = {
  "one long word": "a".repeat(1_000_000),
  "unclosed link brackets": "[http:".repeat(20_000),
  "a line full of numbers": "123456 ".repeat(150_000),
  "trailing dots after a code": "123456 " + ". ".repeat(120_000) + "x",
  "a line full of urls": "http://a ".repeat(30_000),
  "a line full of mailto links": "mailto:a ".repeat(30_000),
  "chained at signs": "a@a@".repeat(100_000),
};

const elapsed = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe("parser on large bodies", () => {
  for (const [name, text] of Object.entries(LARGE_TEXTS)) {
    it(`finishes quickly on ${name}`, () => {
      expect(elapsed(() => extractCodes({ text: text.slice(0, MAX_PARSE_CHARS) }))).toBeLessThan(1000);
      expect(elapsed(() => parseMessage({ subject: "Your code", text }))).toBeLessThan(1000);
      expect(elapsed(() => unsubscribeCandidates(boundedInput({ text })))).toBeLessThan(1000);
    });
  }

  it("finishes quickly on large HTML", () => {
    // HTML goes through an HTML parser several times (linear, but slower than the text passes): ~100 KB pages.
    for (const html of ['<a href="https://x.test/unsubscribe">'.repeat(3_000), "<a ".repeat(30_000), "<b>x</b>".repeat(12_000)])
      expect(elapsed(() => parseMessage({ html }))).toBeLessThan(1000);
  });

  it("only analyses the start of a huge body", () => {
    const text = "Your verification code is 482910.\n" + "lorem ipsum ".repeat(30_000) + "\nOther code: 777111";
    expect(boundedInput({ text }).text!.length).toBe(MAX_PARSE_CHARS);
    expect(parseMessage({ text }).code?.value).toBe("482910");
  });

  it("still masks e-mail addresses and bracketed links", () => {
    expect(extractCodes({ text: "Write to user123456@example.test" })).toHaveLength(0);
    expect(extractCodes({ text: "See [https://ex.test/482910] for details" })).toHaveLength(0);
    expect(extractCodes({ text: "code [482910]" }).map((c) => c.value)).toContain("482910");
  });
});
