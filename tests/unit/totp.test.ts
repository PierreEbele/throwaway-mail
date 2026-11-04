import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, otpauthUri, totp, verifyTotp } from "../../app/server/lib/totp.js";

// RFC 6238 appendix B (SHA-1 seed), truncated to 6 digits.
const SEED = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

describe("totp", () => {
  it("round-trips base32", () => {
    expect(SEED).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(SEED.toLowerCase()).toString()).toBe("12345678901234567890");
  });

  it("matches the RFC 6238 test vectors", () => {
    for (const [t, code] of VECTORS) expect(totp(SEED, t * 1000)).toBe(code);
  });

  it("accepts one step of drift and refuses replays", () => {
    const now = 1111111111_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(SEED, totp(SEED, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(SEED, totp(SEED, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(SEED, totp(SEED, now - 90_000), now)).toBeNull();
    expect(verifyTotp(SEED, totp(SEED, now), now, step)).toBeNull();
    expect(verifyTotp(SEED, "abc", now)).toBeNull();
  });

  it("builds an otpauth URI", () => {
    const u = new URL(otpauthUri(SEED, "me@example.org", "Throwaway Mail"));
    expect(u.protocol).toBe("otpauth:");
    expect(u.host).toBe("totp");
    expect(decodeURIComponent(u.pathname)).toBe("/Throwaway Mail:me@example.org");
    expect(u.searchParams.get("secret")).toBe(SEED);
    expect(u.searchParams.get("issuer")).toBe("Throwaway Mail");
  });
});
