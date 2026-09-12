import crypto from "node:crypto";

const B32 = "abcdefghijkmnpqrstuvwxyz23456789"; // no l, o, 0, 1

export function randomString(len: number, alphabet = B32): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomString(16)}`;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret: string, ...parts: (string | Buffer | Uint8Array)[]): string {
  const h = crypto.createHmac("sha256", secret);
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
