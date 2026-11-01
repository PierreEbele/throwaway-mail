import * as openpgp from "openpgp";
import { randomString } from "../lib/crypto.js";

export interface KeyInfo {
  fingerprint: string;
  user_ids: string[];
  expires_at: number | null;
}

/** Parses an armored public key and checks it can encrypt. Throws a readable error otherwise. */
export async function inspectPublicKey(armored: string): Promise<KeyInfo> {
  let key: openpgp.PublicKey;
  try {
    key = await openpgp.readKey({ armoredKey: armored });
  } catch {
    throw new Error("Not a valid armored OpenPGP public key");
  }
  if (key.isPrivate()) throw new Error("This is a private key: paste the PUBLIC key only");
  try {
    await key.getEncryptionKey();
  } catch {
    throw new Error("This key cannot encrypt (expired, revoked or no encryption subkey)");
  }
  const exp = await key.getExpirationTime();
  return {
    fingerprint: key.getFingerprint().toUpperCase(),
    user_ids: key.getUserIDs(),
    expires_at: exp instanceof Date ? exp.getTime() : null,
  };
}

const header = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 300);
/** RFC 2047 encoded-word when needed. */
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/**
 * Wraps the original message in a PGP/MIME (RFC 3156) envelope encrypted for `armoredKey`.
 * The whole original (headers included) is encrypted; outer headers only keep what is needed to deliver it.
 */
export async function encryptForward(opts: {
  raw: Uint8Array;
  armoredKey: string;
  /** The throwaway address: envelope and From of the new message (must be on a Cloudflare-routed domain). */
  alias: string;
  to: string;
  subject: string | null;
  fromName: string | null;
  fromAddr: string | null;
  hideSubject: boolean;
  now: number;
}): Promise<string> {
  const publicKey = await openpgp.readKey({ armoredKey: opts.armoredKey });
  const encrypted = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: opts.raw }),
    encryptionKeys: publicKey,
    format: "armored",
  });
  const boundary = `tm-pgp-${randomString(20).toLowerCase()}`;
  const domain = opts.alias.split("@")[1] ?? "localhost";
  const display = header(`${opts.fromName || opts.fromAddr || "Unknown sender"} (via Throwaway Mail)`).replace(/"/g, "'");
  const lines = [
    `From: ${encodeWord(display).includes("=?") ? encodeWord(display) : `"${display}"`} <${opts.alias}>`,
    `To: <${opts.to}>`,
    ...(opts.fromAddr ? [`Reply-To: <${header(opts.fromAddr)}>`] : []),
    `Subject: ${opts.hideSubject ? "..." : encodeWord(header(opts.subject ?? "(no subject)"))}`,
    `Date: ${new Date(opts.now).toUTCString()}`,
    `Message-ID: <${randomString(24).toLowerCase()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
    "",
    "This is an OpenPGP/MIME encrypted message (RFC 3156).",
    `--${boundary}`,
    "Content-Type: application/pgp-encrypted",
    "Content-Description: PGP/MIME version identification",
    "",
    "Version: 1",
    "",
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    "Content-Description: OpenPGP encrypted message",
    'Content-Disposition: inline; filename="encrypted.asc"',
    "",
    encrypted.trim(),
    "",
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}
