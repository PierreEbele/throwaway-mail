import crypto from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// 128 * N * r bytes are needed; Node's default maxmem (32 MiB) is exactly that, so leave headroom.
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

/** Returns "scrypt$N$r$p$saltB64$hashB64". */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Constant-time check against a stored hash; malformed hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 2 ** 20) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (!expected.length) return false;
  const key = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: Math.max(MAXMEM, 256 * n * r) });
  return crypto.timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | null = null;

/** Burns the same time as a real check, so unknown e-mails cannot be told apart by latency. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
}
