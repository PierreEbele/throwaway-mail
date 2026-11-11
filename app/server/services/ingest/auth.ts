/** The authserv-id of an Authentication-Results header value: its first token, before any ";" (comments removed). */
export function authservId(value: string): string {
  return (
    value
      .split(";")[0]!
      .replace(/\([^)]*\)/g, " ")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? ""
  );
}

/**
 * Result of one mechanism in the receiving server's Authentication-Results header.
 * Cloudflare reports SPF twice (HELO identity, then MAIL FROM): the MAIL FROM one is what matters.
 * `trusted` (lower-case authserv-ids, from TRUSTED_AUTHSERV_IDS): when non-empty, headers written by any other
 * server are ignored.
 */
export function authResult(
  headers: Array<{ key: string; value: string }>,
  mech: "spf" | "dkim" | "dmarc",
  trusted: readonly string[] = [],
): string | null {
  for (const h of headers) {
    if (h.key !== "authentication-results") continue;
    if (trusted.length && !trusted.includes(authservId(h.value))) continue;
    const clauses = h.value
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c.toLowerCase().startsWith(mech + "="));
    if (!clauses.length) continue;
    const preferred = mech === "spf" ? (clauses.find((c) => /smtp\.mailfrom=/i.test(c)) ?? clauses[0]!) : clauses[0]!;
    const m = new RegExp(`^${mech}=(\\w+)`, "i").exec(preferred);
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}
