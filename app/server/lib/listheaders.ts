/** List-Unsubscribe (RFC 2369) / one-click (RFC 8058) and bulk-mail detection. */

export interface ListInfo {
  /** https unsubscribe URL, if any. */
  url: string | null;
  mailto: string | null;
  /** RFC 8058: the URL accepts a POST "List-Unsubscribe=One-Click". */
  oneClick: boolean;
  bulk: boolean;
}

export function listInfo(headers: Array<{ key: string; value: string }>): ListInfo {
  const get = (k: string) => headers.find((h) => h.key === k)?.value ?? null;
  const lu = get("list-unsubscribe");
  const targets = [...(lu ?? "").matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const url = targets.find((t) => /^https:\/\//i.test(t)) ?? null;
  const mailto = targets.find((t) => /^mailto:/i.test(t)) ?? null;
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
