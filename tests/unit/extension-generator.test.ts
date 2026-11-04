import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// The extension's identity generator (extension/generator.js), run as in the browser.
const sandbox: Record<string, any> = { crypto };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../extension/generator.js"), "utf8"), sandbox);
const G = sandbox.ThrowawayGenerator;

const kinds = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/];

describe("extension identity generator", () => {
  it("gives names that fit the country, and an ASCII placeholder e-mail", () => {
    const seen = { FR: new Set<string>(), GB: new Set<string>(), US: new Set<string>() };
    for (let i = 0; i < 60; i++)
      for (const c of ["FR", "GB", "US"] as const) {
        const p = G.generate(c);
        expect(p.countryCode).toBe(c);
        expect(p.fullName).toBe(`${p.firstName} ${p.lastName}`);
        expect(p.email).toMatch(/^[a-z]+\.[a-z]+\.[0-9a-f]{10}@example\.com$/);
        seen[c].add(p.lastName);
      }
    expect(seen.FR.has("Smith")).toBe(false);
    expect(seen.US.has("Dubois")).toBe(false);
    expect(seen.FR.size).toBeGreaterThan(8); // a real spread, not a handful of names
  });

  it("keeps locked fields from the previous identity", () => {
    const first = G.generate("FR");
    const next = G.generate("US", first, ["lastName", "phone"]);
    expect(next.lastName).toBe(first.lastName);
    expect(next.phone).toBe(first.phone);
    expect(next.countryCode).toBe("FR"); // a locked local field keeps the country
  });

  it("derives password variants that fit a site's length rules, keeping every kind of character", () => {
    for (let i = 0; i < 50; i++) {
      const password = G.generatePassword();
      expect(password).toHaveLength(20);
      const [unchanged, simple] = G.passwordVariants(password);
      expect(unchanged).toBe(password);
      expect(simple).toMatch(/^[A-Za-z0-9]{20}$/);
      for (const max of [8, 12, 16]) {
        const [same, alnum] = G.passwordVariants(password, { maxLength: max });
        expect(same).toHaveLength(max);
        for (const k of kinds) expect(same).toMatch(k);
        expect(alnum).toMatch(/^[A-Za-z0-9]+$/);
        for (const k of kinds.slice(0, 3)) expect(alnum).toMatch(k);
        expect(G.passwordVariants(password, { maxLength: max })).toEqual([same, alnum]); // stable for one identity
      }
      expect(G.passwordVariants(password, { minLength: 32 }).every((v: string) => v.length === 32)).toBe(true);
    }
  });
});
