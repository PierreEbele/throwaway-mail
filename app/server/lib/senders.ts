/** Helpers for comparing a sender with the site an address was created for. */

const MULTI_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "co.jp", "co.nz", "com.br", "co.za", "com.mx", "co.in"]);

/** "mail.news.example.co.uk" -> "example.co.uk". Good enough without a public-suffix list. */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_TLDS.has(last2) ? parts.slice(-3).join(".") : last2;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function senderDomain(addr: string | null | undefined): string | null {
  const at = addr?.lastIndexOf("@") ?? -1;
  return at > 0 ? addr!.slice(at + 1).toLowerCase() : null;
}

export function parseList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** True when `domain` (or a parent of it) is in `list`. */
export function listed(list: string[], domain: string): boolean {
  const d = domain.toLowerCase();
  return list.some((x) => d === x || d.endsWith(`.${x}`) || baseDomain(d) === x);
}

/** Does a mail from `sender` look like it does not come from the site? Null when it can't tell. */
export function looksLikeLeak(siteUrl: string | null, sender: string | null, trusted: string[]): boolean {
  const site = hostOf(siteUrl);
  const from = senderDomain(sender);
  if (!site || !from) return false;
  if (listed(trusted, from)) return false;
  const a = baseDomain(site);
  const b = baseDomain(from);
  if (a === b) return false;
  // Same brand on another TLD (example.com vs example.fr) is fine.
  const brand = (d: string) => d.split(".")[0]!;
  return brand(a) !== brand(b);
}
