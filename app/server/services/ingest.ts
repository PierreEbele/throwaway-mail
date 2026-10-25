import { createHash } from "node:crypto";
import PostalMime, { type Email } from "postal-mime";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addressDestinations, addresses, destinations, directories, domains, extractedItems, leakEvents, messages, users, type Address, type Domain } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { LOCAL_PART_RE, normalizeRecipient } from "../lib/email.js";
import { sanitizeEmail } from "../lib/sanitize.js";
import { authWarning } from "../lib/phishing.js";
import { listInfo } from "../lib/listheaders.js";
import { matchCategory } from "../routes/categories.js";
import { notify } from "./notify.js";
import { encryptForward } from "./pgp.js";
import { runParser } from "../parser/index.js";
import { baseDomain, listed, looksLikeLeak, parseList, senderDomain } from "../lib/senders.js";

export type IngestAction = "forward" | "store_only" | "reject";

export interface IngestResult {
  action: IngestAction;
  forward_to?: string;
  /** Every destination when there are several (forward_to is the first one, for older Workers). */
  forward_to_all?: string[];
  /** PGP-encrypted copies the Worker must send itself (send_email binding), from `from`. */
  send?: Array<{ from: string; to: string; raw_base64: string }>;
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
      categoryId: matchCategory(deps, owner, senderDomain ?? "", senderDomain ? `https://${senderDomain}` : null),
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

/** <dir>.<site>: auto-create an address for <site> owned by the directory's user. */
function resolveDirectory(deps: Deps, domain: Domain, local: string): Address | null {
  const m = /^([a-z0-9]{3,32})\.(.+)$/.exec(local);
  if (!m || domain.status !== "active") return null;
  const dir = deps.db.select().from(directories).where(eq(directories.name, m[1]!)).get();
  if (!dir) return null;
  const site = m[2]!;
  const storedLocal = local;
  if (!LOCAL_PART_RE.test(storedLocal)) return null;
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
  const a = deps.db.select().from(addresses).where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, storedLocal))).get() ?? null;
  if (a) deps.bus.publish(a.userId, { type: "address.created", address_id: a.id });
  return a;
}

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
    ? deps.db.select().from(destinations).where(and(eq(destinations.id, address.destinationId), eq(destinations.userId, address.userId))).get()
    : deps.db
        .select()
        .from(destinations)
        .where(and(eq(destinations.userId, address.userId), isNotNull(destinations.verifiedAt)))
        .orderBy(asc(destinations.createdAt))
        .get();
  return dest?.verifiedAt ? dest.email : null;
}

/**
 * Result of one mechanism in the receiving server's Authentication-Results header.
 * Cloudflare reports SPF twice (HELO identity, then MAIL FROM): the MAIL FROM one is what matters.
 */
export function authResult(headers: Array<{ key: string; value: string }>, mech: "spf" | "dkim" | "dmarc"): string | null {
  for (const h of headers) {
    if (h.key !== "authentication-results") continue;
    const clauses = h.value
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c.toLowerCase().startsWith(mech + "="));
    if (!clauses.length) continue;
    const preferred = mech === "spf" ? (clauses.find((c) => /smtp\.mailfrom=/i.test(c)) ?? clauses[0]!) : clauses[0]!;
    const m = new RegExp(`^${mech}=(\\w+)`, "i").exec(preferred);
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
  let address =
    deps.db.select().from(addresses).where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, rcpt.local))).get() ?? resolveDirectory(deps, domain, rcpt.local);
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
  const fromDomain = senderDomain(email.from?.address) ?? sender?.domain ?? null;
  if (fromDomain && listed(parseList(address.blockedSendersJson), fromDomain)) {
    log.info("reject: blocked sender", { address_id: address.id, sender: fromDomain });
    return { action: "reject", reason: "sender_blocked" };
  }
  const messageIdHeader = email.messageId?.trim() || null;
  const bodyHash = createHash("sha256")
    .update(`${email.from?.address ?? ""}\n${email.subject ?? ""}\n${email.text ?? email.html ?? ""}`)
    .digest("hex");

  if (!messageIdHeader) {
    // No Message-ID: treat an identical mail within 15 minutes as a retried delivery.
    const dup = deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.addressId, address.id), eq(messages.bodyHash, bodyHash), gt(messages.receivedAt, deps.now() - 15 * 60_000)))
      .get();
    if (dup) {
      log.info("duplicate delivery (body hash)", { message_id: dup.id });
      return dup.forwarded && dup.forwardTo
        ? { ...(await forwardDecision(deps, address, dup.forwardTo, input.raw, email, rcpt.full)), message_id: dup.id, duplicate: true }
        : { action: "store_only", message_id: dup.id, duplicate: true };
    }
  }

  if (messageIdHeader) {
    const dup = deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.addressId, address.id), eq(messages.messageIdHeader, messageIdHeader)))
      .get();
    if (dup) {
      log.info("duplicate delivery", { message_id: dup.id });
      return dup.forwarded && dup.forwardTo
        ? { ...(await forwardDecision(deps, address, dup.forwardTo, input.raw, email, rcpt.full)), message_id: dup.id, duplicate: true }
        : { action: "store_only", message_id: dup.id, duplicate: true };
    }
  }

  const parsed = await runParser({ subject: email.subject, text: email.text, html: email.html }, deps.parserStrategies);
  const list = listInfo(email.headers);
  if (address.blockPromos && list.bulk && !parsed.code) {
    log.info("reject: promotional mail blocked", { address_id: address.id });
    return { action: "reject", reason: "promotional_blocked" };
  }
  const clean = email.html ? sanitizeEmail(email.html) : null;
  const auth = { spf: authResult(email.headers, "spf"), dkim: authResult(email.headers, "dkim"), dmarc: authResult(email.headers, "dmarc") };
  const targets = preservedForward ? [preservedForward] : forwardTargets(deps, address);
  const forwardTo = targets.length ? targets.join(", ") : null;
  const now = deps.now();
  const id = newId("msg");
  const headers = email.headers.map((h) => ({ key: h.key, value: h.value.slice(0, 2000) })).slice(0, 200);

  const leak = !address.isUnassigned && looksLikeLeak(address.siteUrl, email.from?.address ?? null, parseList(address.trustedSendersJson));
  const link = `${deps.config.APP_URL.replace(/\/$/, "")}/addresses/${address.id}`;
  if (leak && address.siteLock) {
    // Locked to its site: refuse the mail, but keep the evidence.
    const sender = email.from!.address!.toLowerCase();
    const now = deps.now();
    deps.db.update(addresses).set({ leakSender: sender, leakAt: now }).where(eq(addresses.id, address.id)).run();
    deps.db.insert(leakEvents).values({ id: newId("lek"), userId: address.userId, addressId: address.id, sender, senderDomain: baseDomain(senderDomain(sender)!), at: now }).run();
    deps.bus.publish(address.userId, { type: "address.updated", address_id: address.id });
    void notify(deps, address.userId, {
      type: "leak.detected",
      title: `Blocked leak: ${address.siteName}`,
      body: `${rcpt.full} is locked to ${address.siteName}; mail from ${sender} was rejected.`,
      url: link,
      data: { address_id: address.id, address: rcpt.full, site: address.siteName, from: sender, rejected: true },
    }).catch(() => {});
    log.info("reject: site-locked address", { address_id: address.id, sender });
    return { action: "reject", reason: "sender_not_site" };
  }
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
        html: clean?.html ?? null,
        rawSize: input.raw.byteLength,
        headersJson: JSON.stringify(headers),
        ...auth,
        trackersRemoved: clean?.trackers ?? 0,
        authWarning: address.isUnassigned ? null : authWarning(address.siteUrl, email.from?.address ?? null, auth),
        isBulk: list.bulk,
        unsubscribeUrl: list.url,
        unsubscribeMailto: list.mailto,
        unsubscribeOneClick: list.oneClick,
        forwarded: !!forwardTo,
        forwardTo,
        bodyHash,
        attachmentsJson: email.attachments.length
          ? JSON.stringify(
              email.attachments.slice(0, 50).map((a) => ({
                filename: a.filename ?? null,
                mime_type: a.mimeType,
                size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
                inline: a.disposition === "inline",
              })),
            )
          : null,
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
    tx.update(addresses)
      .set({ lastMessageAt: now, ...(leak ? { leakSender: email.from!.address!.toLowerCase(), leakAt: now } : {}) })
      .where(eq(addresses.id, address!.id))
      .run();
    if (leak) {
      const sender = email.from!.address!.toLowerCase();
      tx.insert(leakEvents).values({ id: newId("lek"), userId: address!.userId, addressId: address!.id, sender, senderDomain: baseDomain(senderDomain(sender)!), at: now }).run();
    }
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

  const site = address.siteName;
  const data = { address_id: address.id, address: rcpt.full, site, message_id: id, from: email.from?.address ?? null, subject: email.subject ?? null };
  const pushes: Promise<unknown>[] = [
    notify(deps, address.userId, { type: "message.received", title: `New mail for ${site}`, body: `${email.from?.address ?? "?"}: ${email.subject ?? "(no subject)"}`, url: link, data }),
  ];
  if (parsed.code) {
    pushes.push(notify(deps, address.userId, { type: "code.received", title: `Code ${parsed.code.value}`, body: `${site} · ${email.subject ?? ""}`.trim(), url: link, data: { ...data, code: parsed.code.value } }));
  }
  if (leak) {
    pushes.push(
      notify(deps, address.userId, {
        type: "leak.detected",
        title: `Possible leak: ${site}`,
        body: `${rcpt.full} received mail from ${email.from?.address}, which is not ${site}.`,
        url: link,
        data,
      }),
    );
  }
  // Self-destructing addresses: pause after N mails or after the first code.
  const count = address.maxMessages ? deps.db.select({ n: sql<number>`count(*)` }).from(messages).where(eq(messages.addressId, address.id)).get()!.n : 0;
  const burn = address.burnAfterCode && parsed.code ? "after_code" : address.maxMessages && count >= address.maxMessages ? "max_messages" : null;
  if (burn) {
    deps.db.update(addresses).set({ status: "paused", burnReason: burn, burnedAt: now, updatedAt: now }).where(eq(addresses.id, address.id)).run();
    deps.bus.publish(address.userId, { type: "address.updated", address_id: address.id });
    pushes.push(
      notify(deps, address.userId, {
        type: "address.burned",
        title: `${site}: address burned`,
        body: burn === "after_code" ? `${rcpt.full} received its code and now rejects mail.` : `${rcpt.full} reached ${address.maxMessages} mail(s) and now rejects mail.`,
        url: link,
        data: { ...data, reason: burn },
      }),
    );
  }
  // Never delay the Worker's answer on slow notification endpoints.
  void Promise.all(pushes).catch(() => {});

  return forwardTo ? { ...(await forwardDecision(deps, address, forwardTo, input.raw, email, rcpt.full)), message_id: id } : { action: "store_only", message_id: id };
}

/**
 * messages.forward_to holds "a@x, b@y". Destinations with an OpenPGP key get an encrypted copy the Worker sends
 * itself; the others are plain Cloudflare forwards.
 */
async function forwardDecision(deps: Deps, address: Address, stored: string, raw: Uint8Array, email: Email, alias: string): Promise<IngestResult> {
  const all = stored.split(",").map((x) => x.trim()).filter(Boolean);
  const keys = new Map(
    deps.db
      .select()
      .from(destinations)
      .where(and(eq(destinations.userId, address.userId), isNotNull(destinations.pgpPublicKey)))
      .all()
      .map((d) => [d.email, d]),
  );
  const plain = all.filter((e) => !keys.has(e));
  const send: NonNullable<IngestResult["send"]> = [];
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
