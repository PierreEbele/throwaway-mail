import type { Email } from "postal-mime";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { addressDestinations, destinations, users, type Address } from "../../db/schema.js";
import { encryptForward } from "../pgp.js";
import { contactFor, domainOf, outboundFor, rewriteForward } from "../replies.js";
import { filterHeaders, fromAlias, headerAllowlist, stripAttachments } from "./transform.js";
import type { IngestResult } from "./types.js";

/** Every verified destination mail for this address goes to right now (extra destinations included). */
export function forwardTargets(deps: Deps, address: Address): string[] {
  if (!address.forwardEnabled || deps.config.DEMO_MODE) return [];
  const extra = deps.db
    .select({ email: destinations.email })
    .from(addressDestinations)
    .innerJoin(destinations, eq(destinations.id, addressDestinations.destinationId))
    .where(and(eq(addressDestinations.addressId, address.id), eq(destinations.userId, address.userId), isNotNull(destinations.verifiedAt)))
    .all()
    .map((x) => x.email);
  const main = forwardTarget(deps, address);
  return [...new Set([...(main ? [main] : []), ...extra])];
}

/** Which destination (if any) mail for this address goes to right now. */
export function forwardTarget(deps: Deps, address: Address): string | null {
  if (!address.forwardEnabled) return null;
  const dest = address.destinationId
    ? deps.db
        .select()
        .from(destinations)
        .where(and(eq(destinations.id, address.destinationId), eq(destinations.userId, address.userId)))
        .get()
    : deps.db
        .select()
        .from(destinations)
        .where(and(eq(destinations.userId, address.userId), isNotNull(destinations.verifiedAt)))
        .orderBy(asc(destinations.createdAt))
        .get();
  return dest?.verifiedAt ? dest.email : null;
}

/** Verified destinations of the user, as e-mail addresses, in the order of the given ids. */
export function destinationEmails(deps: Deps, userId: string, ids: string[]): string[] {
  if (!ids.length) return [];
  const rows = deps.db
    .select()
    .from(destinations)
    .where(and(eq(destinations.userId, userId), inArray(destinations.id, ids), isNotNull(destinations.verifiedAt)))
    .all();
  return ids.map((id) => rows.find((r) => r.id === id)?.email).filter((x): x is string => !!x);
}

/** The address's own fallback list (destination ids), or [] when it uses the user's chain. */
export function addressFallbackIds(address: Address): string[] {
  try {
    const v = address.fallbackDestinationIdsJson ? (JSON.parse(address.fallbackDestinationIdsJson) as unknown) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Where mail goes when forwarding to the usual destinations fails: the address's own list, else the user's chain. */
export function fallbackChain(deps: Deps, address: Address, exclude: string[]): string[] {
  const ids = addressFallbackIds(address);
  const emails = ids.length
    ? destinationEmails(deps, address.userId, ids)
    : deps.db
        .select({ email: destinations.email })
        .from(destinations)
        .where(and(eq(destinations.userId, address.userId), isNotNull(destinations.fallbackPosition), isNotNull(destinations.verifiedAt)))
        .orderBy(asc(destinations.fallbackPosition))
        .all()
        .map((d) => d.email);
  return emails.filter((e) => !exclude.includes(e));
}

/** The user's header allowlist (null: forwards keep every header). */
export function userHeaderAllowlist(deps: Deps, userId: string): string[] | null {
  const u = deps.db.select({ j: users.forwardHeaderAllowlistJson }).from(users).where(eq(users.id, userId)).get();
  return headerAllowlist(u?.j ?? null);
}

/** The forwarded copy with a reverse Reply-To, or null when replies are off / impossible for this mail. */
function replyRewrite(deps: Deps, address: Address, email: Email, raw: Uint8Array, alias: string): Buffer | null {
  const sender = email.from?.address?.toLowerCase();
  if (!address.repliesEnabled || !sender || !sender.includes("@")) return null;
  const domain = domainOf(deps, address);
  if (!outboundFor(deps, domain)) return null;
  const contact = contactFor(deps, address, sender, email.from?.name || null);
  return rewriteForward(raw, {
    alias,
    reverse: `r+${contact.token}@${domain.name}`,
    senderEmail: sender,
    senderName: email.from?.name || null,
  });
}

export interface ForwardOptions {
  /** A rule asked to remove attachments from the forwarded copy. */
  stripAttachments?: boolean;
  /** Original headers to keep (null: all of them). */
  headerAllowlist?: string[] | null;
  /** Fallback destinations, in order (see IngestResult.fallback_to). */
  fallbacks?: string[];
}

/** The copy actually forwarded (attachments removed, headers filtered), or null when it is the original. */
export function changedCopy(raw: Uint8Array, email: Email, opts: ForwardOptions): Buffer | null {
  let changed: Buffer | null = null;
  if (opts.stripAttachments && email.attachments.length) changed = stripAttachments(raw, email);
  if (opts.headerAllowlist) changed = filterHeaders(changed ?? raw, opts.headerAllowlist);
  return changed;
}

/**
 * messages.forward_to holds "a@x, b@y". Destinations with an OpenPGP key get an encrypted copy the Worker sends
 * itself; the others are plain Cloudflare forwards, unless the copy must be changed first (reverse-alias replies,
 * attachments removed, headers filtered): then the Worker sends the changed copy as a new message too.
 */
export async function forwardDecision(
  deps: Deps,
  address: Address,
  stored: string,
  raw: Uint8Array,
  email: Email,
  alias: string,
  opts: ForwardOptions = {},
): Promise<IngestResult> {
  const all = stored
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const keys = new Map(
    deps.db
      .select()
      .from(destinations)
      .where(and(eq(destinations.userId, address.userId), isNotNull(destinations.pgpPublicKey)))
      .all()
      .map((d) => [d.email, d]),
  );
  const send: NonNullable<IngestResult["send"]> = [];
  let changed = changedCopy(raw, email, opts);
  // Reverse-alias replies: every copy is rewritten (From the alias, Reply-To r+<token>), so none can be a plain
  // forward of the original; the Worker (send_email) or the mailbox's SMTP server sends them as new messages.
  const rewritten = replyRewrite(deps, address, email, changed ?? raw, alias);
  if (!rewritten && changed) changed = fromAlias(changed, alias, email.from?.address?.toLowerCase() ?? null, email.from?.name || null);
  const copy = rewritten ?? changed;
  if (copy) raw = copy;
  const plain = copy ? [] : all.filter((e) => !keys.has(e));
  if (copy)
    for (const to of all.filter((e) => !keys.has(e))) send.push({ from: alias, to, raw_base64: Buffer.from(copy).toString("base64") });
  for (const to of all.filter((e) => keys.has(e))) {
    const dest = keys.get(to)!;
    try {
      const mime = await encryptForward({
        raw,
        armoredKey: dest.pgpPublicKey!,
        alias,
        to,
        subject: email.subject ?? null,
        fromName: email.from?.name || null,
        fromAddr: email.from?.address ?? null,
        hideSubject: dest.pgpHideSubject,
        now: deps.now(),
      });
      send.push({ from: alias, to, raw_base64: Buffer.from(mime, "utf8").toString("base64"), encrypted: true });
    } catch (err) {
      // Never fall back to a clear-text forward for a destination that asked for encryption.
      deps.logger.error("pgp encryption failed", { destination: dest.id, err: err as Error });
    }
  }
  if (!plain.length && !send.length) return { action: "store_only" };
  // An encrypted copy is useless to another destination, and a destination with a key must never get clear text.
  const fallbacks = (opts.fallbacks ?? []).filter((e) => !all.includes(e) && !keys.has(e));
  return {
    action: "forward",
    ...(plain.length ? { forward_to: plain[0], ...(plain.length > 1 ? { forward_to_all: plain } : {}) } : {}),
    ...(send.length ? { send } : {}),
    ...(fallbacks.length ? { fallback_to: fallbacks } : {}),
  };
}
