/** Normalise a recipient: lowercase, strip plus-tag. Returns null if not an address. */
export function normalizeRecipient(addr: string): { local: string; domain: string; full: string } | null {
  const m = /^\s*<?([^<>@\s]+)@([^<>@\s]+?)>?\s*$/.exec(addr);
  if (!m) return null;
  let local = m[1]!.toLowerCase();
  const domain = m[2]!.toLowerCase().replace(/\.$/, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  return { local, domain, full: `${local}@${domain}` };
}

export const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
