import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import {
  addressDestinations,
  addresses,
  destinations,
  domains,
  extractedItems,
  messages,
  siteRejections,
  users,
  type Address,
  type User,
} from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { LOCAL_PART_RE } from "../lib/email.js";
import { addressSettings, generateLocalPart } from "./alias-format.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { addressOut } from "./serialize.js";
import { checkCategory, matchCategory } from "./categories.js";
import { domainOf, repliesUnavailableReason } from "./replies.js";
import { noMailWarning, pickDomain } from "./sites.js";

export function messageCounts(deps: Deps, ids: string[]) {
  const map = new Map<string, { unread: number; total: number }>();
  if (!ids.length) return map;
  const rows = deps.db
    .select({
      id: messages.addressId,
      total: sql<number>`count(*)`,
      unread: sql<number>`sum(case when ${messages.readAt} is null and ${messages.archivedAt} is null then 1 else 0 end)`,
    })
    .from(messages)
    .where(inArray(messages.addressId, ids))
    .groupBy(messages.addressId)
    .all();
  for (const r of rows) map.set(r.id, { unread: r.unread ?? 0, total: r.total });
  return map;
}

/** Every address lookup is scoped by user id; another user's address is indistinguishable from a missing one. */
export function ownedAddress(deps: Deps, user: User, id: string) {
  const row = deps.db
    .select({ a: addresses, domain: domains.name })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(and(eq(addresses.id, id), eq(addresses.userId, user.id)))
    .get();
  if (!row) throw notFound("Address");
  return row;
}

export function warnMinutes(deps: Deps, userId: string): number {
  return deps.db.select({ m: users.noMailWarnMinutes }).from(users).where(eq(users.id, userId)).get()?.m ?? 0;
}

export function addressWithCounts(deps: Deps, a: Address, domain: string) {
  const counts = messageCounts(deps, [a.id]).get(a.id);
  const extra = deps.db
    .select({ id: addressDestinations.destinationId })
    .from(addressDestinations)
    .where(eq(addressDestinations.addressId, a.id))
    .all()
    .map((x) => x.id);
  return {
    ...addressOut(a, domain, counts),
    extra_destination_ids: extra,
    /** Why reverse-alias replies cannot be used on this address's domain (null: they can). */
    replies_unavailable: repliesUnavailableReason(deps, domainOf(deps, a)),
    /** Nothing received yet, some minutes after creation: the site may not have sent its code, or rejected the domain. */
    no_mail_warning: noMailWarning(a, counts?.total ?? 0, deps.now(), warnMinutes(deps, a.userId)),
    /** The user reported that this address's site rejected its domain. */
    site_rejected: !!deps.db.select({ id: siteRejections.id }).from(siteRejections).where(eq(siteRejections.addressId, a.id)).get(),
  };
}

export function checkDestination(deps: Deps, user: User, id: string | null | undefined) {
  if (!id) return;
  const d = deps.db
    .select()
    .from(destinations)
    .where(and(eq(destinations.id, id), eq(destinations.userId, user.id)))
    .get();
  if (!d) throw badRequest("Unknown destination_id");
}

export function itemsFor(deps: Deps, ids: string[]) {
  const map = new Map<string, (typeof extractedItems.$inferSelect)[]>();
  if (!ids.length) return map;
  for (const it of deps.db.select().from(extractedItems).where(inArray(extractedItems.messageId, ids)).all()) {
    (map.get(it.messageId) ?? map.set(it.messageId, []).get(it.messageId)!).push(it);
  }
  return map;
}

export interface NewAddress {
  domain?: string;
  site_name: string;
  site_url?: string | null;
  local_part?: string;
  label?: string;
  forward?: boolean;
  destination_id?: string;
  category_id?: string | null;
  expires_at?: number | null;
  expires_in_days?: number;
  /** Pause the address automatically after this many mails. */
  max_messages?: number | null;
  /** Used when `domain` is not given, unless the site rejected it. */
  preferred_domain?: string;
  /** Never pick these domains (when `domain` is not given). */
  exclude_domain_ids?: string[];
}

/** Creates an address for `user`. Shared by `POST /v1/addresses` and the alias-service compatibility API. */
export function createAddress(d: Deps, user: User, body: NewAddress): { a: Address; domain: string; avoided: string[] } {
  const pick = body.domain ? null : pickDomain(d, user, body, { preferred: body.preferred_domain, exclude: body.exclude_domain_ids });
  const domain = body.domain
    ? d.db
        .select()
        .from(domains)
        .where(or(eq(domains.name, body.domain), eq(domains.id, body.domain)))
        .get()
    : pick!.domain;
  if (!domain) throw badRequest(body.domain ? `Unknown domain ${body.domain}` : "No active domain is configured yet");
  if (domain.status !== "active") throw badRequest(`Domain ${domain.name} is not active yet`);
  if (body.local_part !== undefined && !LOCAL_PART_RE.test(body.local_part)) {
    throw badRequest("local_part may contain a-z, 0-9, '.', '_' and '-', must start and end with a letter or digit (max 64)");
  }
  checkDestination(d, user, body.destination_id);
  checkCategory(d, user, body.category_id);
  const now = d.now();
  // The user's defaults apply when the creator says nothing (an explicit null means "never" / "no limit").
  const prefs = addressSettings(user);
  const expiryDays = body.expires_in_days ?? (body.expires_at === undefined ? prefs.default_expires_in_days : null);
  const expiresAt = body.expires_at ?? (expiryDays ? now + expiryDays * 86400_000 : null);
  const maxMessages = body.max_messages === undefined ? prefs.default_max_messages : body.max_messages;
  for (let attempt = 0; attempt < 12; attempt++) {
    const localPart = body.local_part ?? generateLocalPart(prefs, body.site_name, attempt);
    const row = {
      id: newId("adr"),
      userId: user.id,
      domainId: domain.id,
      localPart,
      siteName: body.site_name,
      siteUrl: body.site_url ?? null,
      label: body.label ?? null,
      forwardEnabled: body.forward ?? false,
      destinationId: body.destination_id ?? null,
      categoryId: body.category_id === undefined ? matchCategory(d, user.id, body.site_name, body.site_url ?? null) : body.category_id,
      expiresAt,
      maxMessages: maxMessages ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const res = d.db.insert(addresses).values(row).onConflictDoNothing().run();
    if (res.changes === 1) {
      const a = d.db.select().from(addresses).where(eq(addresses.id, row.id)).get()!;
      d.bus.publish(user.id, { type: "address.created", address_id: a.id });
      return { a, domain: domain.name, avoided: pick?.avoided.map((x) => x.name) ?? [] };
    }
    if (body.local_part) throw conflict(`${body.local_part}@${domain.name} is already taken`);
  }
  throw conflict("Could not allocate a unique address, try again");
}

/**
 * Create a fresh address for the same site (copying category, forwarding, pin and protections) and pause or archive
 * the old one. The new address keeps the old domain unless `exclude_domain_ids` asks for another one.
 */
export function replaceAddress(
  d: Deps,
  user: User,
  old: Address,
  opts: { archive_old?: boolean; exclude_domain_ids?: string[] } = {},
): { a: Address; domain: string } {
  const { a, domain } = createAddress(d, user, {
    domain: opts.exclude_domain_ids ? undefined : old.domainId,
    exclude_domain_ids: opts.exclude_domain_ids,
    site_name: old.siteName,
    site_url: old.siteUrl,
    label: old.label ?? undefined,
    forward: old.forwardEnabled,
    destination_id: old.destinationId ?? undefined,
    category_id: old.categoryId,
  });
  d.db
    .update(addresses)
    .set({
      pinned: old.pinned,
      blockPromos: old.blockPromos,
      siteLock: old.siteLock,
      blockedSendersJson: old.blockedSendersJson,
      trustedSendersJson: old.trustedSendersJson,
    })
    .where(eq(addresses.id, a.id))
    .run();
  d.db
    .update(addresses)
    .set({
      status: opts.archive_old ? "archived" : "paused",
      pinned: false,
      leakSender: null,
      leakAt: null,
      label: `replaced by ${a.localPart}@${domain}`,
      updatedAt: d.now(),
    })
    .where(eq(addresses.id, old.id))
    .run();
  d.bus.publish(user.id, { type: "address.updated", address_id: old.id });
  return { a: d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain };
}
