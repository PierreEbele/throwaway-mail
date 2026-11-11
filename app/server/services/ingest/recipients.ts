import { and, asc, eq } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { addresses, categories, directories, users, type Address, type Domain, type User } from "../../db/schema.js";
import { newId } from "../../lib/crypto.js";
import { LOCAL_PART_RE } from "../../lib/email.js";
import { matchCategory } from "../categories.js";
import { heldAfterDeletion } from "../addresses.js";

const UNASSIGNED_LOCAL = "_unassigned";

export function domainOwner(deps: Pick<Deps, "db">, domain: Domain): string | null {
  if (domain.createdBy) return domain.createdBy;
  const admin = deps.db.select().from(users).where(eq(users.role, "admin")).orderBy(asc(users.createdAt)).get();
  return admin?.id ?? null;
}

/**
 * Whether `domain` forwards unknown addresses to a preserved catch-all that is not kept by `user`. Names claimed on
 * such a domain would take mail away from the catch-all's owner (the domain owner), so only that owner and admins
 * may claim them.
 */
export function catchAllKeptByOther(deps: Pick<Deps, "db">, domain: Domain, user: Pick<User, "id" | "role">): boolean {
  if (!domain.catchallForwardTo || user.role === "admin") return false;
  return domainOwner(deps, domain) !== user.id;
}

function resolveUnknown(deps: Deps, domain: Domain, local: string, senderDomain: string | null): Address | null {
  const owner = domainOwner(deps, domain);
  if (!owner || domain.unknownPolicy === "reject") return null;
  const now = deps.now();
  if (domain.unknownPolicy === "auto_create" && LOCAL_PART_RE.test(local)) {
    // Catch-all auto-create: the configured user (else the domain owner) gets a real address on the fly.
    const userId =
      (domain.autoCreateUserId && deps.db.select({ id: users.id }).from(users).where(eq(users.id, domain.autoCreateUserId)).get()?.id) ||
      owner;
    const fixedCategory = domain.autoCreateCategoryId
      ? deps.db
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.id, domain.autoCreateCategoryId), eq(categories.userId, userId)))
          .get()?.id
      : undefined;
    const siteUrl = senderDomain ? `https://${senderDomain}` : null;
    const row = {
      id: newId("adr"),
      userId,
      domainId: domain.id,
      localPart: local,
      siteName: senderDomain ? senderDomain : "Auto-created",
      siteUrl,
      label: "auto-created",
      categoryId: fixedCategory ?? matchCategory(deps, userId, senderDomain ?? "", siteUrl),
      createdAt: now,
      updatedAt: now,
    };
    const created = deps.db.insert(addresses).values(row).onConflictDoNothing().run().changes === 1;
    const a =
      deps.db
        .select()
        .from(addresses)
        .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, local)))
        .get() ?? null;
    if (a && created) deps.bus.publish(a.userId, { type: "address.created", address_id: a.id });
    return a;
  }
  // "inbox" (or auto_create with an unusable local part): the domain owner's unassigned box.
  deps.db
    .insert(addresses)
    .values({
      id: newId("adr"),
      userId: owner,
      domainId: domain.id,
      localPart: UNASSIGNED_LOCAL,
      siteName: `Unassigned (${domain.name})`,
      isUnassigned: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return (
    deps.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, UNASSIGNED_LOCAL)))
      .get() ?? null
  );
}

/** <dir>.<site>: auto-create an address for <site> owned by the directory's user. */
function resolveDirectory(deps: Deps, domain: Domain, local: string): Address | null {
  const m = /^([a-z0-9]{3,32})\.(.+)$/.exec(local);
  if (!m || domain.status !== "active") return null;
  const dir = deps.db.select().from(directories).where(eq(directories.name, m[1]!)).get();
  if (!dir) return null;
  // On a domain with a preserved catch-all, only its owner's (or an admin's) directories apply: others' mail stays
  // with the catch-all.
  if (domain.catchallForwardTo) {
    const dirOwner = deps.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, dir.userId)).get();
    if (!dirOwner || catchAllKeptByOther(deps, domain, dirOwner)) return null;
  }
  const site = m[2]!;
  const storedLocal = local;
  if (!LOCAL_PART_RE.test(storedLocal)) return null;
  if (heldAfterDeletion(deps, dir.userId, domain.id, storedLocal)) return null;
  const now = deps.now();
  const siteUrl = /\.[a-z]{2,}$/.test(site) ? `https://${site}` : null;
  deps.db
    .insert(addresses)
    .values({
      id: newId("adr"),
      userId: dir.userId,
      domainId: domain.id,
      localPart: storedLocal,
      siteName: site,
      siteUrl,
      label: `directory ${dir.name}`,
      categoryId: matchCategory(deps, dir.userId, site, siteUrl),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  const a =
    deps.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, storedLocal)))
      .get() ?? null;
  if (a) deps.bus.publish(a.userId, { type: "address.created", address_id: a.id });
  return a;
}

export interface Recipient {
  address: Address;
  /** Set when the domain keeps forwarding unknown addresses to its previous catch-all destination. */
  preservedForward: string | null;
}

/** Finds (or, depending on the domain's policy, creates) the address a mail is for. Null: reject. */
export function resolveRecipient(deps: Deps, domain: Domain, local: string, senderDomain: string | null): Recipient | null {
  const known =
    deps.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, local)))
      .get() ?? resolveDirectory(deps, domain, local);
  if (known) return { address: known, preservedForward: null };
  // Domain whose previous catch-all is preserved: unknown addresses keep going to the old destination
  // and are queued in the owner's "To sort" box so they can be registered as sites.
  if (domain.catchallForwardTo) {
    const box = resolveUnknown(deps, { ...domain, unknownPolicy: "inbox" }, local, null);
    if (box) return { address: box, preservedForward: domain.catchallForwardTo };
  }
  const created = resolveUnknown(deps, domain, local, senderDomain);
  return created ? { address: created, preservedForward: null } : null;
}
