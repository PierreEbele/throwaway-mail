import type { Message } from "../db/schema.js";
import { pickUnsubscribe, unsubscribeCandidates, type UnsubscribeCandidate } from "../parser/unsubscribe.js";

/** Unsubscribe targets of a stored message (headers and body), best first. */
export function candidatesOf(m: Message): UnsubscribeCandidate[] {
  let headers: Array<{ key: string; value: string }> = [];
  try {
    headers = m.headersJson ? JSON.parse(m.headersJson) : [];
  } catch {
    /* ignore */
  }
  const found = unsubscribeCandidates({ headers, text: m.text, html: m.html });
  // Stored at ingest (from the original, unsanitized body): keep it in case the sanitized HTML lost it.
  if (m.unsubscribeUrl || m.unsubscribeMailto)
    found.push({ kind: m.unsubscribeOneClick ? "one_click" : "body", url: m.unsubscribeUrl, mailto: m.unsubscribeMailto });
  return pickUnsubscribe(found);
}
