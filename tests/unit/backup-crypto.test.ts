import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, isEncrypted } from "../../app/web/src/backupCrypto.js";

describe("encrypted export", () => {
  it("round-trips and rejects a wrong passphrase", async () => {
    const data = { addresses: [{ email: "été@x.test", site_name: "Café" }], big: "x".repeat(100_000) };
    const file = await encryptJson(data, "correct horse", 1000);
    expect(isEncrypted(file)).toBe(true);
    expect(JSON.stringify(file)).not.toContain("Café");
    expect(await decryptJson(file, "correct horse")).toEqual(data);
    await expect(decryptJson(file, "wrong")).rejects.toThrow("Wrong passphrase");
    expect(isEncrypted({ addresses: [] })).toBe(false);
  });
});
