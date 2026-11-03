/**
 * Which address of our domain a mail in a catch-all mailbox was delivered to. Envelope headers added by the
 * receiving server win (they also cover Bcc and mailing lists); To / Cc are the fallback.
 */
const ENVELOPE_HEADERS = ["delivered-to", "x-original-to", "x-envelope-to", "envelope-to"];
const VISIBLE_HEADERS = ["to", "cc"];

/** Header fields of a raw message (unfolded, names lower-cased, in order). */
export function parseHeaders(raw: Uint8Array): Array<{ name: string; value: string }> {
  const text = Buffer.from(raw.subarray(0, 256 * 1024)).toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const block = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const out: Array<{ name: string; value: string }> = [];
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  return out;
}

/** Bare addresses in a header value, ignoring display names (quoted strings and comments). */
export function addressesIn(value: string): string[] {
  const stripped = value.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\((?:[^()\\]|\\.)*\)/g, " ");
  return [...stripped.matchAll(/[^\s<>,;:"]+@[^\s<>,;:"]+/g)].map((m) => m[0].toLowerCase().replace(/\.$/, ""));
}

export function findRecipient(raw: Uint8Array, domain: string): string | null {
  const headers = parseHeaders(raw);
  const suffix = `@${domain.toLowerCase()}`;
  for (const names of [ENVELOPE_HEADERS, VISIBLE_HEADERS]) {
    for (const h of headers) {
      if (!names.includes(h.name)) continue;
      const hit = addressesIn(h.value).find((a) => a.endsWith(suffix));
      if (hit) return hit;
    }
  }
  return null;
}

/** Envelope sender for ingest: Return-Path, else the From address. */
export function findSender(raw: Uint8Array): string {
  const headers = parseHeaders(raw);
  for (const name of ["return-path", "from"]) {
    const h = headers.find((x) => x.name === name);
    const a = h && addressesIn(h.value)[0];
    if (a) return a;
  }
  return "";
}
