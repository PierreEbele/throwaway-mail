import PostalMime from "postal-mime";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, destinations, domains, extractedItems, messages, users, type Address, type Domain } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { LOCAL_PART_RE, normalizeRecipient } from "../lib/email.js";
import { sanitizeEmailHtml } from "../lib/sanitize.js";
import { runParser } from "../parser/index.js";

export type IngestAction = "forward" | "store_only" | "reject";

export interface IngestResult {
  action: IngestAction;
  forward_to?: string;
  reason?: string;
  message_id?: string;
  duplicate?: boolean;
}

export interface IngestInput {
  raw: Uint8Array;
  envelopeFrom: string;
  envelopeTo: string;
}

const UNASSIGNED_LOCAL = "_unassigned";

function domainOwner(deps: Deps, domain: Domain): string | null {
  if (domain.createdBy) return domain.createdBy;
  const admin = deps.db.select().from(users).where(eq(users.role, "admin")).orderBy(asc(users.createdAt)).get();
  return admin?.id ?? null;
}

function resolveUnknown(deps: Deps, domain: Domain, local: string, senderDomain: string | null): Address | null {
  const owner = domainOwner(deps, domain);
  if (!owner || domain.unknownPolicy === "reject") return null;
  const now = deps.now();
  if (domain.unknownPolicy === "auto_create" && LOCAL_PART_RE.test(local)) {
    const row = {
      id: newId("adr"),
      userId: owner,
      domainId: domain.id,
      localPart: local,
      siteName: senderDomain ? senderDomain : "Auto-created",
      siteUrl: senderDomain ? `https://${senderDomain}` : null,
      label: "auto-created",
      createdAt: now,
      updatedAt: now,
    };
    deps.db.insert(addresses).values(row).onConflictDoNothing().run();
    return deps.db.select().from(addresses).where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, local))).get() ?? null;
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
  return deps.db.select().from(addresses).where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, UNASSIGNED_LOCAL))).get() ?? null;
}

/** Which destination (if any) mail for this address goes to right now. */
export function forwardTarget(deps: Deps, address: Address): string | null {
  if (!address.forwardEnabled) return null;
  const dest = address.destinationId
    ? deps.db.select().from(destinations).where(and(eq(destinations.id, address.destinationId), eq(destinations.userId, address.userId))).get()
    : deps.db
        .select()
        .from(destinations)
        .where(and(eq(destinations.userId, address.userId), isNotNull(destinations.verifiedAt)))
        .orderBy(asc(destinations.createdAt))
        .get();
  return dest?.verifiedAt ? dest.email : null;
}

function authResult(headers: Array<{ key: string; value: string }>, mech: string): string | null {
  for (const h of headers) {
    if (h.key !== "authentication-results") continue;
    const m = new RegExp(`\\b${mech}=(\\w+)`, "i").exec(h.value);
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}

export async function ingestMessage(deps: Deps, input: IngestInput): Promise<IngestResult> {
  const log = deps.logger.child({ component: "ingest" });
  const rcpt = normalizeRecipient(input.envelopeTo);
  if (!rcpt) return { action: "reject", reason: "invalid_recipient" };

  const domain = deps.db.select().from(domains).where(eq(domains.name, rcpt.domain)).get();
  if (!domain) {
    log.info("reject: unknown domain", { domain: rcpt.domain });
    return { action: "reject", reason: "unknown_domain" };
  }

  const sender = normalizeRecipient(input.envelopeFrom);
  let address = deps.db.select().from(addresses).where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, rcpt.local))).get() ?? null;
  // Domain whose previous catch-all is preserved: unknown addresses keep going to the old destination
  // and are queued in the owner's "To sort" box so they can be registered as sites.
  let preservedForward: string | null = null;
  if (!address && domain.catchallForwardTo) {
    address = resolveUnknown(deps, { ...domain, unknownPolicy: "inbox" }, rcpt.local, null);
    preservedForward = domain.catchallForwardTo;
  }
  if (!address) {
    address = resolveUnknown(deps, domain, rcpt.local, sender?.domain ?? null);
    if (!address) {
      log.info("reject: unknown recipient", { domain: domain.name, policy: domain.unknownPolicy });
      return { action: "reject", reason: "unknown_recipient" };
    }
  }
  if (address.status !== "active") return { action: "reject", reason: `address_${address.status}` };
  if (address.expiresAt && address.expiresAt <= deps.now()) return { action: "reject", reason: "address_expired" };

  const email = await PostalMime.parse(input.raw);
  const messageIdHeader = email.messageId?.trim() || null;

  if (messageIdHeader) {
    const dup = deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.addressId, address.id), eq(messages.messageIdHeader, messageIdHeader)))
      .get();
    if (dup) {
      log.info("duplicate delivery", { message_id: dup.id });
      return dup.forwarded && dup.forwardTo
        ? { action: "forward", forward_to: dup.forwardTo, message_id: dup.id, duplicate: true }
        : { action: "store_only", message_id: dup.id, duplicate: true };
    }
  }

  const parsed = await runParser({ subject: email.subject, text: email.text, html: email.html }, deps.parserStrategies);
  const forwardTo = preservedForward ?? forwardTarget(deps, address);
  const now = deps.now();
  const id = newId("msg");
  const headers = email.headers.map((h) => ({ key: h.key, value: h.value.slice(0, 2000) })).slice(0, 200);

  deps.db.transaction((tx) => {
    tx.insert(messages)
      .values({
        id,
        addressId: address!.id,
        userId: address!.userId,
        messageIdHeader,
        envelopeFrom: input.envelopeFrom || null,
        envelopeTo: rcpt.full,
        fromAddr: email.from?.address ?? null,
        fromName: email.from?.name || null,
        subject: email.subject ?? null,
        receivedAt: now,
        text: email.text ?? null,
        html: email.html ? sanitizeEmailHtml(email.html) : null,
        rawSize: input.raw.byteLength,
        headersJson: JSON.stringify(headers),
        spf: authResult(email.headers, "spf"),
        dkim: authResult(email.headers, "dkim"),
        dmarc: authResult(email.headers, "dmarc"),
        forwarded: !!forwardTo,
        forwardTo,
      })
      .run();
    const items = [
      ...(parsed.code ? [parsed.code] : []).concat(parsed.alternatives).map((c, i) => ({
        id: newId("itm"),
        messageId: id,
        kind: "code" as const,
        value: c.value,
        confidence: c.confidence,
        method: parsed.strategy === "deterministic" ? c.method : `${parsed.strategy}:${c.method}`,
        label: c.raw,
        rank: parsed.code ? i : i + 1, // rank 0 is reserved for the accepted best code
      })),
      ...parsed.links.map((l, i) => ({
        id: newId("itm"),
        messageId: id,
        kind: "link" as const,
        value: l.url,
        confidence: l.confidence,
        method: l.method,
        label: l.label ?? null,
        rank: i,
      })),
    ];
    if (items.length) tx.insert(extractedItems).values(items).run();
    tx.update(addresses).set({ lastMessageAt: now }).where(eq(addresses.id, address!.id)).run();
  });

  log.info("stored message", { message_id: id, address_id: address.id, size: input.raw.byteLength, has_code: !!parsed.code, action: forwardTo ? "forward" : "store_only" });
  log.debug("parsed", { message_id: id, code: parsed.code?.value, links: parsed.links.length });

  deps.bus.publish(address.userId, {
    type: "message.received",
    address_id: address.id,
    message_id: id,
    subject: email.subject ?? null,
    from: email.from?.address ?? null,
    received_at: now,
    has_code: !!parsed.code,
  });

  return forwardTo ? { action: "forward", forward_to: forwardTo, message_id: id } : { action: "store_only", message_id: id };
}
