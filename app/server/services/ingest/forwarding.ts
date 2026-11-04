import type { Email } from "postal-mime";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { addressDestinations, destinations, type Address } from "../../db/schema.js";
import { encryptForward } from "../pgp.js";
import { contactFor, domainOf, outboundFor, rewriteForward } from "../replies.js";
import type { IngestResult } from "./types.js";

/** Every verified destination mail for this address goes to right now (extra destinations included). */
export function forwardTargets(deps: Deps, address: Address): string[] {
  if (!address.forwardEnabled) return [];
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

/**
 * messages.forward_to holds "a@x, b@y". Destinations with an OpenPGP key get an encrypted copy the Worker sends
 * itself; the others are plain Cloudflare forwards.
 */
export async function forwardDecision(
  deps: Deps,
  address: Address,
  stored: string,
  raw: Uint8Array,
  email: Email,
  alias: string,
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
  // Reverse-alias replies: every copy is rewritten (From the alias, Reply-To r+<token>), so none can be a plain
  // forward of the original; the Worker (send_email) or the mailbox's SMTP server sends them as new messages.
  const rewritten = replyRewrite(deps, address, email, raw, alias);
  if (rewritten) raw = rewritten;
  const plain = rewritten ? [] : all.filter((e) => !keys.has(e));
  if (rewritten)
    for (const to of all.filter((e) => !keys.has(e))) send.push({ from: alias, to, raw_base64: Buffer.from(rewritten).toString("base64") });
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
      send.push({ from: alias, to, raw_base64: Buffer.from(mime, "utf8").toString("base64") });
    } catch (err) {
      // Never fall back to a clear-text forward for a destination that asked for encryption.
      deps.logger.error("pgp encryption failed", { destination: dest.id, err: err as Error });
    }
  }
  if (!plain.length && !send.length) return { action: "store_only" };
  return {
    action: "forward",
    ...(plain.length ? { forward_to: plain[0], ...(plain.length > 1 ? { forward_to_all: plain } : {}) } : {}),
    ...(send.length ? { send } : {}),
  };
}
