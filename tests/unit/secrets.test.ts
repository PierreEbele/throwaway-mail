import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../app/server/lib/secrets.js";

describe("stored secrets", () => {
  it("round-trips and fails with another key", () => {
    const k = "k".repeat(32);
    const enc = encryptSecret(k, "imap password é");
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain("password");
    expect(decryptSecret(k, enc)).toBe("imap password é");
    expect(() => decryptSecret("x".repeat(32), enc)).toThrow();
  });
});
