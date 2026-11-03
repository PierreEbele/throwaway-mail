import crypto from "node:crypto";

/**
 * Symmetric encryption for secrets kept in the database (IMAP/SMTP passwords): AES-256-GCM with a key derived from
 * APP_SECRET. Format: "v1:<iv>:<tag>:<ciphertext>", base64url parts.
 */
const key = (appSecret: string) => crypto.createHash("sha256").update(`throwaway-mail/secrets/v1\n${appSecret}`).digest();

export function encryptSecret(appSecret: string, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(appSecret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(":");
}

export function decryptSecret(appSecret: string, stored: string): string {
  const [v, iv, tag, ct] = stored.split(":");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(appSecret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
