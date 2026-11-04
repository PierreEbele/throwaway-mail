import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encrypted backup format (".enc"):
 *   "TMBK1\n" (6 bytes) | salt (16) | IV (12) | AES-256-GCM ciphertext | GCM tag (16)
 * The key is scrypt(passphrase, salt, N=2^15, r=8, p=1, 32 bytes). Any tampering makes decryption fail.
 */
export const BACKUP_MAGIC = Buffer.from("TMBK1\n");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function key(passphrase: string, salt: Buffer) {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

export function encryptBackup(plain: Uint8Array, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, salt, iv, body, cipher.getAuthTag()]);
}

export function decryptBackup(data: Uint8Array, passphrase: string): Buffer {
  const buf = Buffer.from(data);
  const head = BACKUP_MAGIC.length;
  if (buf.length < head + 16 + 12 + 16 || !buf.subarray(0, head).equals(BACKUP_MAGIC)) {
    throw new Error("not an encrypted Throwaway Mail backup");
  }
  const salt = buf.subarray(head, head + 16);
  const iv = buf.subarray(head + 16, head + 28);
  const tag = buf.subarray(buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buf.subarray(head + 28, buf.length - 16)), decipher.final()]);
  } catch {
    throw new Error("decryption failed: wrong passphrase or corrupted file");
  }
}
