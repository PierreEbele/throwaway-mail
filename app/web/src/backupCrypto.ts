/** Passphrase-encrypted export files: PBKDF2-SHA256 (600k iterations) + AES-256-GCM, all in the browser. */

export const ENCRYPTED_FORMAT = "throwaway-mail-encrypted-1";
const ITERATIONS = 600_000;

export interface EncryptedFile {
  format: typeof ENCRYPTED_FORMAT;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(value: unknown, passphrase: string, iterations = ITERATIONS): Promise<EncryptedFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(passphrase, salt, iterations), plain));
  // Chunked base64 so large exports don't blow the argument limit of String.fromCharCode.
  let data = "";
  for (let i = 0; i < ct.length; i += 0x8000) data += String.fromCharCode(...ct.subarray(i, i + 0x8000));
  return {
    format: ENCRYPTED_FORMAT,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    data: btoa(data),
  };
}

export function isEncrypted(v: unknown): v is EncryptedFile {
  return !!v && typeof v === "object" && (v as { format?: unknown }).format === ENCRYPTED_FORMAT;
}

/** Throws "Wrong passphrase" when the passphrase (or file) is wrong. */
export async function decryptJson<T = unknown>(file: EncryptedFile, passphrase: string): Promise<T> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(file.cipher.iv) },
      await key(passphrase, unb64(file.kdf.salt), file.kdf.iterations),
      unb64(file.data),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new Error("Wrong passphrase or damaged file");
  }
}
