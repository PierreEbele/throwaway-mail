import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, domains, siteRejections, type Address, type Domain, type User } from "../db/schema.js";
import { newId } from "../lib/crypto.js";

/** Normalised keys of a site: host of its URL without "www.", and the lower-case site name. */
export function siteKeys(siteName: string | null | undefined, siteUrl: string | null | undefined): string[] {
  const keys = new Set<string>();
  if (siteUrl) {
    try {
      keys.add(new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      /* not a URL */
    }
  }
  const name = siteName?.trim().toLowerCase();
  if (name) keys.add(name);
  return [...keys];
}

/** The key stored for a rejection: the host when known, else the name. */
export function siteKey(siteName: string | null | undefined, siteUrl: string | null | undefined): string {
  return siteKeys(siteName, siteUrl)[0] ?? "";
}

/** Domains that a site is known to reject, as reported by any user of the instance (only site and domain are shared). */
export function rejectedDomainIds(d: Deps, siteName: string | null | undefined, siteUrl: string | null | undefined): Set<string> {
  const keys = siteKeys(siteName, siteUrl);
  if (!keys.length) return new Set();
  return new Set(
    d.db
      .selectDistinct({ id: siteRejections.domainId })
      .from(siteRejections)
      .where(inArray(siteRejections.site, keys))
      .all()
      .map((r) => r.id),
  );
}

export interface DomainPick {
  domain: Domain | undefined;
  /** Active domains skipped because the site rejected them. */
  avoided: Domain[];
}

/**
 * Domain for a new address when the caller did not force one: active domains minus those the site rejected, then the
 * user's choice (first, random, rotate), or `choice` for this call. `preferred` (name or id) wins when it is active and not rejected.
 * When the site rejected every domain, falls back to all active domains (minus `exclude`).
 */
export function pickDomain(
  d: Deps,
  user: User,
  site: { site_name?: string | null; site_url?: string | null },
  opts: { preferred?: string; exclude?: string[]; choice?: User["domainChoice"] } = {},
): DomainPick {
  const choice = opts.choice ?? user.domainChoice;
  const exclude = new Set(opts.exclude ?? []);
  const active = d.db
    .select()
    .from(domains)
    .where(eq(domains.status, "active"))
    .orderBy(asc(domains.createdAt), asc(sql`rowid`))
    .all();
  const rejected = rejectedDomainIds(d, site.site_name, site.site_url);
  const avoided = active.filter((x) => rejected.has(x.id));
  let pool = active.filter((x) => !rejected.has(x.id) && !exclude.has(x.id));
  if (!pool.length) pool = active.filter((x) => !exclude.has(x.id));
  if (opts.preferred) {
    const p = pool.find((x) => x.name === opts.preferred || x.id === opts.preferred);
    if (p) return { domain: p, avoided };
  }
  if (pool.length <= 1 || choice === "first") return { domain: pool[0], avoided };
  if (choice === "random") return { domain: pool[Math.floor(Math.random() * pool.length)], avoided };
  // rotate: the next domain after the one of the user's latest address
  const last = d.db
    .select({ domainId: addresses.domainId })
    .from(addresses)
    .where(and(eq(addresses.userId, user.id), eq(addresses.isUnassigned, false)))
    .orderBy(desc(addresses.createdAt), desc(sql`${addresses}.rowid`))
    .get();
  const i = last ? active.findIndex((x) => x.id === last.domainId) : -1;
  for (let k = 1; k <= active.length; k++) {
    const next = active[(i + k) % active.length]!;
    if (pool.includes(next)) return { domain: next, avoided };
  }
  return { domain: pool[0], avoided };
}

/** Remember that the address's site rejected its domain. Idempotent per (user, site, domain). */
export function recordRejection(d: Deps, user: User, a: Address) {
  const site = siteKey(a.siteName, a.siteUrl);
  const now = d.now();
  d.db
    .insert(siteRejections)
    .values({ id: newId("rej"), userId: user.id, site, domainId: a.domainId, addressId: a.id, createdAt: now })
    .onConflictDoUpdate({
      target: [siteRejections.userId, siteRejections.site, siteRejections.domainId],
      set: { addressId: a.id, createdAt: now },
    })
    .run();
  return d.db
    .select()
    .from(siteRejections)
    .where(and(eq(siteRejections.userId, user.id), eq(siteRejections.site, site), eq(siteRejections.domainId, a.domainId)))
    .get()!;
}

/** Instance-wide view for admins: which sites reject which domains, and how many users reported it. */
export function rejectionStats(d: Deps) {
  return d.db
    .select({
      site: siteRejections.site,
      domain: domains.name,
      domain_id: domains.id,
      reports: sql<number>`count(*)`,
      last_at: sql<number>`max(${siteRejections.createdAt})`,
    })
    .from(siteRejections)
    .innerJoin(domains, eq(domains.id, siteRejections.domainId))
    .groupBy(siteRejections.site, siteRejections.domainId)
    .orderBy(desc(sql`count(*)`), asc(siteRejections.site))
    .all();
}

/** True when an active address received nothing `minutes` after creation (only during its first day). */
export function noMailWarning(a: Address, total: number, now: number, minutes: number): boolean {
  if (!minutes || total > 0 || a.status !== "active" || a.isUnassigned || a.lastMessageAt) return false;
  const age = now - a.createdAt;
  return age >= minutes * 60_000 && age < 24 * 3600_000;
}
