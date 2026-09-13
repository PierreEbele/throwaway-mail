import { hash, verify } from "@node-rs/argon2";

// Argon2id (algorithm 2), OWASP-recommended parameters that fit a 1 GB VPS.
const OPTS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
let dummy: string | null = null;

export async function hashPassword(pw: string): Promise<string> {
  return hash(pw, OPTS);
}

export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  if (!stored) {
    // Spend the same time when the user does not exist.
    dummy ??= await hash("dummy-password-for-timing", OPTS);
    await verify(dummy, pw).catch(() => false);
    return false;
  }
  return verify(stored, pw).catch(() => false);
}
