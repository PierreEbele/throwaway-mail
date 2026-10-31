/**
 * Result of one mechanism in the receiving server's Authentication-Results header.
 * Cloudflare reports SPF twice (HELO identity, then MAIL FROM): the MAIL FROM one is what matters.
 */
export function authResult(headers: Array<{ key: string; value: string }>, mech: "spf" | "dkim" | "dmarc"): string | null {
  for (const h of headers) {
    if (h.key !== "authentication-results") continue;
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
