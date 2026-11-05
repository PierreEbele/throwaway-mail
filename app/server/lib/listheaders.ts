/** List-Unsubscribe (RFC 2369) / one-click (RFC 8058) and bulk-mail detection. */

export interface ListInfo {
  /** https unsubscribe URL, if any. */
  url: string | null;
  mailto: string | null;
  /** RFC 8058: the URL accepts a POST "List-Unsubscribe=One-Click". */
  oneClick: boolean;
  bulk: boolean;
}

/** Targets of a List-Unsubscribe value: `<url>, <mailto:...>`, or bare comma-separated URLs (non-compliant but sent by e.g. Slack). */
export function listUnsubscribeTargets(value: string | null): string[] {
  const v = value ?? "";
  const bracketed = [...v.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.replace(/\s+/g, ""));
  if (bracketed.length) return bracketed;
  return v
    .split(",")
    .map((t) => t.replace(/\s+/g, ""))
    .filter((t) => /^(?:https?:\/\/|mailto:)/i.test(t));
}

export function listInfo(headers: Array<{ key: string; value: string }>): ListInfo {
  const get = (k: string) => headers.find((h) => h.key === k)?.value ?? null;
  const lu = get("list-unsubscribe");
  const targets = listUnsubscribeTargets(lu);
  const url = targets.find((t) => /^https:\/\//i.test(t)) ?? null;
  const mailto = safeMailto(targets.find((t) => /^mailto:/i.test(t)));
  const oneClick = !!url && /list-unsubscribe=one-click/i.test(get("list-unsubscribe-post") ?? "");
  const precedence = (get("precedence") ?? "").toLowerCase();
  const bulk =
    !!lu ||
    !!get("list-id") ||
    precedence === "bulk" ||
    precedence === "list" ||
    !!get("x-campaign") ||
    !!get("x-mailchimp-campaign") ||
    /bulk|marketing/i.test(get("x-ms-exchange-organization-scl") ?? "");
  return { url, mailto, oneClick, bulk };
}

const MAILBOX_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * A mailto: unsubscribe target the user can safely open: a single, well-formed recipient, and only the subject/body
 * hints of RFC 2369 (cc/bcc/to/in-reply-to and friends would copy the alias to third parties; CR/LF would inject
 * headers). Null when it does not qualify.
 */
export function safeMailto(raw: string | null | undefined): string | null {
  if (!raw || !/^mailto:/i.test(raw) || raw.length > 2048) return null;
  const rest = raw.slice(7);
  const q = rest.indexOf("?");
  let to: string;
  let params: URLSearchParams;
  try {
    to = decodeURIComponent(q < 0 ? rest : rest.slice(0, q)).trim();
    params = new URLSearchParams(q < 0 ? "" : rest.slice(q + 1));
  } catch {
    return null;
  }
  if (!MAILBOX_RE.test(to)) return null;
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    const key = k.toLowerCase();
    if ((key !== "subject" && key !== "body") || out.has(key)) continue;
    if (/[\r\n\0]/.test(v) && key === "subject") return null;
    out.set(key, v.replace(/\0/g, "").slice(0, 500));
  }
  const qs = [...out].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `mailto:${to}${qs ? `?${qs}` : ""}`;
}
