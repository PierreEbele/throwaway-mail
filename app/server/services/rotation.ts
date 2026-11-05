import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, domains, users, type Address, type User } from "../db/schema.js";
import { addressSettings } from "./alias-format.js";
import { replaceAddress } from "./addresses.js";
import { notify } from "./notify.js";

const DAY = 86400_000;

export interface RotationPolicy {
  mode: "off" | "after_leak" | "every";
  days: number;
  graceDays: number;
}

/** The rotation that applies to an address: its own setting, or the account default for "default" / null fields. */
export function rotationPolicy(user: Pick<User, "addressSettingsJson">, a: Address): RotationPolicy {
  const s = addressSettings(user);
  return {
    mode: a.rotationMode === "default" ? s.rotation_mode : a.rotationMode,
    days: a.rotationDays ?? s.rotation_days,
    graceDays: a.rotationGraceDays ?? s.rotation_grace_days,
  };
}

/** When the address is due for rotation (null: never). */
export function rotationDueAt(p: RotationPolicy, a: Address): number | null {
  if (p.mode === "after_leak") return a.leakAt == null ? null : a.leakAt + p.days * DAY;
  if (p.mode === "every") return p.days > 0 ? a.createdAt + p.days * DAY : null;
  return null;
}

/**
 * Replaces the address with a fresh one for the same site (same domain, same settings). The old one keeps receiving
 * for the grace period, then `endRotationGrace` pauses it. Notifies the user with the new address.
 */
export function rotateAddress(deps: Deps, user: User, old: Address, graceDays: number): { a: Address; domain: string } {
  const now = deps.now();
  const keep = graceDays > 0;
  const graceUntil = keep ? now + graceDays * DAY : null;
  const { a, domain } = replaceAddress(deps, user, old, { keep_old_active: keep });
  deps.db
    .update(addresses)
    .set({ rotatedToId: a.id, rotationGraceUntil: graceUntil, ...(keep ? {} : { burnReason: "rotated", burnedAt: now }) })
    .where(eq(addresses.id, old.id))
    .run();
  const oldDomain = deps.db.select({ n: domains.name }).from(domains).where(eq(domains.id, old.domainId)).get()?.n ?? "";
  const oldEmail = `${old.localPart}@${oldDomain}`;
  const newEmail = `${a.localPart}@${domain}`;
  const tail = keep ? ` ${oldEmail} keeps receiving for ${graceDays} day(s).` : ` ${oldEmail} no longer receives mail.`;
  void notify(deps, user.id, {
    type: "address.rotated",
    title: `${old.siteName}: address rotated`,
    body: `Update your account on ${old.siteName} to ${newEmail}.${tail}`,
    url: `${deps.config.APP_URL.replace(/\/$/, "")}/addresses/${a.id}`,
    data: {
      address_id: a.id,
      address: newEmail,
      old_address_id: old.id,
      old_address: oldEmail,
      site: old.siteName,
      site_url: old.siteUrl,
      grace_until: graceUntil,
    },
  }).catch(() => {});
  return { a, domain };
}

/** Rotates every active address whose schedule is due. Returns the number of rotations. */
export function runRotations(deps: Deps): number {
  const now = deps.now();
  const rows = deps.db
    .select({ a: addresses, u: users })
    .from(addresses)
    .innerJoin(users, eq(users.id, addresses.userId))
    .where(and(eq(addresses.status, "active"), eq(addresses.isUnassigned, false), isNull(addresses.rotatedToId), eq(users.disabled, false)))
    .all();
  let n = 0;
  for (const { a, u } of rows) {
    const p = rotationPolicy(u, a);
    const due = rotationDueAt(p, a);
    if (due == null || due > now) continue;
    try {
      rotateAddress(deps, u, a, p.graceDays);
      n++;
    } catch (e) {
      deps.logger.warn("address rotation failed", { address: a.id, err: e as Error });
    }
  }
  if (n) deps.logger.info("addresses rotated", { count: n });
  return n;
}

/** Pauses rotated addresses whose grace period is over. Returns the count. */
export function endRotationGrace(deps: Deps): number {
  const now = deps.now();
  const rows = deps.db
    .select({ id: addresses.id, userId: addresses.userId })
    .from(addresses)
    .where(and(eq(addresses.status, "active"), isNotNull(addresses.rotationGraceUntil), lte(addresses.rotationGraceUntil, now)))
    .all();
  for (const r of rows) {
    deps.db
      .update(addresses)
      .set({ status: "paused", burnReason: "rotated", burnedAt: now, rotationGraceUntil: null, updatedAt: now })
      .where(eq(addresses.id, r.id))
      .run();
    deps.bus.publish(r.userId, { type: "address.updated", address_id: r.id });
  }
  return rows.length;
}
