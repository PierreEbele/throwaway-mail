import crypto from "node:crypto";

/** TOTP (RFC 6238) with HMAC-SHA1, 6 digits and 30 s steps: the parameters every authenticator app supports. */
export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(msg).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const bin = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(bin).padStart(TOTP_DIGITS, "0");
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_S);

export function totp(secretB32: string, nowMs: number): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs));
}

/**
 * Checks a code against the current step ± `window` steps (clock drift). Returns the matching step, or null.
 * Steps at or before `lastStep` are refused so an observed code cannot be replayed.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: number | null = null, window = 1): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(nowMs);
  for (let s = now - window; s <= now + window; s++) {
    if (lastStep !== null && s <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c))) return s;
  }
  return null;
}

/** 160-bit secret, base32 (32 characters). */
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_S) });
  return `otpauth://totp/${label}?${q}`;
}
