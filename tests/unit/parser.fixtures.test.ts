import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { parseMessage } from "../../app/server/parser/index.js";

const dir = path.join(__dirname, "..", "fixtures");
const expected: Record<string, { code: string | null; link?: string; noLink?: boolean }> = JSON.parse(
  fs.readFileSync(path.join(dir, "expected.json"), "utf8"),
);

describe("parser fixtures", () => {
  it("has at least 25 fixtures", () => {
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(25);
  });

  for (const [file, exp] of Object.entries(expected)) {
    it(file, async () => {
      const raw = fs.readFileSync(path.join(dir, file));
      const email = await PostalMime.parse(raw);
      const result = parseMessage({ subject: email.subject, text: email.text, html: email.html });
      if (exp.code === null) expect(result.code?.value ?? null, JSON.stringify(result.code)).toBeNull();
      else {
        expect(result.code?.value, JSON.stringify({ code: result.code, alts: result.alternatives })).toBe(exp.code);
        expect(result.code!.confidence).toBeGreaterThan(0.3);
      }
      if (exp.link) expect(result.links.map((l) => l.url).join("\n")).toContain(exp.link);
      if (exp.noLink) expect(result.links).toEqual([]);
    });
  }
});
