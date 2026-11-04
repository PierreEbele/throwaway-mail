import { and, eq, gt, isNotNull, isNull, lte, ne } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, domains } from "../db/schema.js";
import { notify } from "./notify.js";

export const EXPIRY_WARNING_MS = 24 * 3600_000;

/**
 * Pauses active addresses whose expiry date has passed (burn reason "expired"), so they show as disabled and the
 * Worker rejects their mail like any paused address. Only one address when `addressId` is given. Returns the count.
 */
export function pauseExpired(deps: Deps, addressId?: string): number {
  const now = deps.now();
  const rows = deps.db
    .select({
      id: addresses.id,
      userId: addresses.userId,
      siteName: addresses.siteName,
      localPart: addresses.localPart,
      domain: domains.name,
      expiresAt: addresses.expiresAt,
    })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(
      and(
        eq(addresses.status, "active"),
        isNotNull(addresses.expiresAt),
        lte(addresses.expiresAt, now),
        ...(addressId ? [eq(addresses.id, addressId)] : []),
      ),
    )
    .all();
  for (const r of rows) {
    deps.db
      .update(addresses)
      .set({ status: "paused", burnReason: "expired", burnedAt: now, updatedAt: now })
      .where(eq(addresses.id, r.id))
      .run();
    deps.bus.publish(r.userId, { type: "address.updated", address_id: r.id });
    void notify(deps, r.userId, {
      type: "address.expired",
      title: `${r.siteName}: address expired`,
      body: `${r.localPart}@${r.domain} expired and now rejects mail.`,
      url: `${deps.config.APP_URL.replace(/\/$/, "")}/addresses/${r.id}`,
      data: { address_id: r.id, address: `${r.localPart}@${r.domain}`, site: r.siteName, expires_at: r.expiresAt },
    }).catch(() => {});
  }
  if (rows.length && !addressId) deps.logger.info("expired addresses paused", { count: rows.length });
  return rows.length;
}

/** Notifies once per address when it expires within 24 h. Returns the number of reminders sent. */
export function runExpiryReminders(deps: Deps): number {
  const now = deps.now();
  const rows = deps.db
    .select({ a: addresses, domain: domains.name })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(
      and(
        isNotNull(addresses.expiresAt),
        gt(addresses.expiresAt, now),
        lte(addresses.expiresAt, now + EXPIRY_WARNING_MS),
        isNull(addresses.expiryRemindedAt),
        ne(addresses.status, "archived"),
      ),
    )
    .all();
  for (const { a, domain } of rows) {
    deps.db.update(addresses).set({ expiryRemindedAt: now }).where(eq(addresses.id, a.id)).run();
    const hours = Math.max(1, Math.round((a.expiresAt! - now) / 3600_000));
    void notify(deps, a.userId, {
      type: "address.expiring",
      title: `${a.siteName}: address expires in ${hours} h`,
      body: `${a.localPart}@${domain} will stop accepting mail. Open the app to extend it.`,
      url: `${deps.config.APP_URL.replace(/\/$/, "")}/addresses/${a.id}`,
      data: { address_id: a.id, address: `${a.localPart}@${domain}`, site: a.siteName, expires_at: a.expiresAt },
    }).catch(() => {});
  }
  if (rows.length) deps.logger.info("expiry reminders sent", { count: rows.length });
  return rows.length;
}
