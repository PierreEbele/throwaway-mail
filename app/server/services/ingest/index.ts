import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import { and, eq, gt } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { addresses, domains, extractedItems, messageRaw, messages, type Address, type Message } from "../../db/schema.js";
import { applyAddressEffects, emptyEffect, evaluate, recordMatches, rulesFor } from "../rules/engine.js";
import type { RuleEffect } from "../rules/types.js";
import { newId } from "../../lib/crypto.js";
import { normalizeRecipient } from "../../lib/email.js";
import { sanitizeEmail } from "../../lib/sanitize.js";
import { authWarning } from "../../lib/phishing.js";
import { listInfo } from "../../lib/listheaders.js";
import { listed, looksLikeLeak, parseList, senderDomain } from "../../lib/senders.js";
import { boundedInput, runParser } from "../../parser/index.js";
import { unsubscribeCandidates } from "../../parser/unsubscribe.js";
import { pauseExpired } from "../reminders.js";
import { handleReply, REVERSE_LOCAL_RE } from "../replies.js";
import { authResult } from "./auth.js";
import { afterStore, emitBlocked, recordLeak, rejectLockedLeak } from "./effects.js";
import {
  destinationEmails,
  fallbackChain,
  forwardDecision,
  forwardTargets,
  userHeaderAllowlist,
  type ForwardOptions,
} from "./forwarding.js";
import { resolveRecipient } from "./recipients.js";
import type { IngestInput, IngestResult } from "./types.js";

export type { IngestAction, IngestInput, IngestResult } from "./types.js";
export { authResult } from "./auth.js";
export { forwardTarget, forwardTargets } from "./forwarding.js";

/** Raw MIME of forwarded mail is kept this long, so a failed delivery can be retried. */
export const RAW_KEEP_MS = 3 * 86400_000;
/** Limits of the parsed header list (the full header section is kept separately, up to RAW_HEADERS_MAX). */
export const MAX_HEADERS = 500;
export const MAX_HEADER_VALUE = 8000;
export const RAW_HEADERS_MAX = 256 * 1024;

/** The header section of a raw message, as text. */
export function rawHeaderSection(raw: Uint8Array): string {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, Math.min(raw.byteLength, RAW_HEADERS_MAX + 4));
  const text = buf.toString("utf8");
  const m = /\r?\n\r?\n/.exec(text);
  return (m ? text.slice(0, m.index) : text).slice(0, RAW_HEADERS_MAX);
}

/** How a duplicate delivery of a stored mail is forwarded again (the same way as the first time). */
function duplicateOptions(deps: Deps, address: Address, dup: Message): ForwardOptions {
  const targets = (dup.forwardTo ?? "").split(",").map((x) => x.trim());
  return {
    stripAttachments: dup.stripAttachments,
    headerAllowlist: userHeaderAllowlist(deps, address.userId),
    fallbacks: fallbackChain(deps, address, targets),
  };
}

function ruleReject(deps: Deps, address: Address, effect: RuleEffect, sender: string | null): IngestResult {
  recordMatches(deps, effect);
  applyAddressEffects(deps, address, effect, sender);
  return { action: "reject", reason: "rule_blocked" };
}

/**
 * Decides what happens to one incoming mail (store, forward, reject) and stores it.
 * Called by POST /ingest for every mail the Email Worker receives.
 */
export async function ingestMessage(deps: Deps, input: IngestInput): Promise<IngestResult> {
  const log = deps.logger.child({ component: "ingest" });
  const rcpt = normalizeRecipient(input.envelopeTo);
  if (!rcpt) return { action: "reject", reason: "invalid_recipient" };

  const domain = deps.db.select().from(domains).where(eq(domains.name, rcpt.domain)).get();
  if (!domain) {
    log.info("reject: unknown domain", { domain: rcpt.domain });
    return { action: "reject", reason: "unknown_domain" };
  }

  deps.db.update(domains).set({ lastIngestAt: deps.now() }).where(eq(domains.id, domain.id)).run();
  // r+<token>@domain (normalizeRecipient drops the "+tag", so match the raw recipient): a reply to relay.
  const reverse = REVERSE_LOCAL_RE.exec(input.envelopeTo.trim().replace(/^<|>$/g, "").split("@")[0]!.toLowerCase());
  if (reverse) return handleReply(deps, domain, reverse[1]!, input);
  const sender = normalizeRecipient(input.envelopeFrom);
  const resolved = resolveRecipient(deps, domain, rcpt.local, sender?.domain ?? null);
  if (!resolved) {
    log.info("reject: unknown recipient", { domain: domain.name, policy: domain.unknownPolicy });
    return { action: "reject", reason: "unknown_recipient" };
  }
  const { address, preservedForward } = resolved;
  const envelopeSender = sender?.full ?? null;
  if (address.status !== "active") {
    emitBlocked(deps, address, rcpt.full, envelopeSender, `address_${address.status}`);
    return { action: "reject", reason: `address_${address.status}` };
  }
  if (address.expiresAt && address.expiresAt <= deps.now()) {
    pauseExpired(deps, address.id);
    emitBlocked(deps, address, rcpt.full, envelopeSender, "address_expired");
    return { action: "reject", reason: "address_expired" };
  }

  const email = await PostalMime.parse(input.raw);
  const fromDomain = senderDomain(email.from?.address) ?? sender?.domain ?? null;
  if (fromDomain && listed(parseList(address.blockedSendersJson), fromDomain)) {
    log.info("reject: blocked sender", { address_id: address.id, sender: fromDomain });
    emitBlocked(deps, address, rcpt.full, email.from?.address ?? envelopeSender, "sender_blocked");
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
        ? {
            ...(await forwardDecision(deps, address, dup.forwardTo, input.raw, email, rcpt.full, duplicateOptions(deps, address, dup))),
            message_id: dup.id,
            duplicate: true,
          }
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
        ? {
            ...(await forwardDecision(deps, address, dup.forwardTo, input.raw, email, rcpt.full, duplicateOptions(deps, address, dup))),
            message_id: dup.id,
            duplicate: true,
          }
        : { action: "store_only", message_id: dup.id, duplicate: true };
    }
  }

  // Code, link and unsubscribe extraction only look at the first MAX_PARSE_CHARS of each body.
  const body = boundedInput({ subject: email.subject, text: email.text, html: email.html });
  const parsed = await runParser(body, deps.parserStrategies);
  const list = listInfo(email.headers);
  // No List-Unsubscribe URL: fall back to an unsubscribe link or button found in the body.
  const unsub = list.url ? null : unsubscribeCandidates({ text: body.text, html: body.html }).find((u) => u.url);
  if (address.blockPromos && list.bulk && !parsed.code) {
    log.info("reject: promotional mail blocked", { address_id: address.id });
    emitBlocked(deps, address, rcpt.full, email.from?.address ?? envelopeSender, "promotional_blocked");
    return { action: "reject", reason: "promotional_blocked" };
  }
  const clean = email.html ? sanitizeEmail(email.html) : null;
  const auth = {
    spf: authResult(email.headers, "spf"),
    dkim: authResult(email.headers, "dkim"),
    dmarc: authResult(email.headers, "dmarc"),
  };
  const headers = email.headers.map((h) => ({ key: h.key, value: h.value.slice(0, MAX_HEADER_VALUE) })).slice(0, MAX_HEADERS);
  const senderAddr = email.from?.address?.toLowerCase() ?? sender?.full ?? null;

  // Mail rules (preserved catch-all mail belongs to nobody yet: no rules).
  const effect = preservedForward
    ? emptyEffect()
    : evaluate(rulesFor(deps, address), {
        sender: senderAddr,
        subject: email.subject ?? null,
        recipient: rcpt.full,
        categoryId: address.categoryId,
        attachments: email.attachments.filter((a) => a.disposition !== "inline").length,
        size: input.raw.byteLength,
        headers,
        auth,
        isBulk: list.bulk,
        hasCode: !!parsed.code,
      });
  if (effect.block) {
    log.info("reject: blocked by a rule", { address_id: address.id, rules: effect.matched.map((m) => m.id) });
    return ruleReject(deps, address, effect, senderAddr);
  }

  const ruleTargets = effect.forwardTo.length ? destinationEmails(deps, address.userId, [...new Set(effect.forwardTo)]) : null;
  const targets = effect.quarantine
    ? []
    : preservedForward
      ? [preservedForward]
      : ruleTargets?.length
        ? ruleTargets
        : forwardTargets(deps, address);
  const forwardTo = targets.length ? targets.join(", ") : null;
  const forwardOpts: ForwardOptions = {
    stripAttachments: effect.stripAttachments,
    headerAllowlist: preservedForward ? null : userHeaderAllowlist(deps, address.userId),
    fallbacks: preservedForward ? [] : fallbackChain(deps, address, targets),
  };
  const now = deps.now();
  const id = newId("msg");

  const leak = !address.isUnassigned && looksLikeLeak(address.siteUrl, email.from?.address ?? null, parseList(address.trustedSendersJson));
  if (leak && address.siteLock) {
    const from = email.from!.address!.toLowerCase();
    rejectLockedLeak(deps, address, rcpt.full, from);
    log.info("reject: site-locked address", { address_id: address.id, sender: from });
    emitBlocked(deps, address, rcpt.full, from, "sender_not_site");
    return { action: "reject", reason: "sender_not_site" };
  }
  deps.db.transaction((tx) => {
    tx.insert(messages)
      .values({
        id,
        addressId: address.id,
        userId: address.userId,
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
        unsubscribeUrl: list.url ?? unsub?.url ?? null,
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
        rawHeaders: rawHeaderSection(input.raw),
        matchedRulesJson: effect.matched.length ? JSON.stringify(effect.matched) : null,
        quarantinedAt: effect.quarantine ? now : null,
        stripAttachments: effect.stripAttachments,
        readAt: effect.markRead ? now : null,
      })
      .run();
    // Quarantined mail may be released later; forwarded mail may need a retry: keep the raw message for that.
    if (effect.quarantine || forwardTo)
      tx.insert(messageRaw)
        .values({ messageId: id, raw: Buffer.from(input.raw), keepUntil: effect.quarantine ? null : now + RAW_KEEP_MS })
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
    tx.update(addresses).set({ lastMessageAt: now }).where(eq(addresses.id, address.id)).run();
    if (leak) recordLeak(tx, address, email.from!.address!.toLowerCase(), now);
  });

  log.info("stored message", {
    message_id: id,
    address_id: address.id,
    size: input.raw.byteLength,
    has_code: !!parsed.code,
    action: forwardTo ? "forward" : "store_only",
  });
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

  afterStore(deps, {
    address,
    rcpt: rcpt.full,
    messageId: id,
    from: email.from?.address ?? null,
    subject: email.subject ?? null,
    code: parsed.code?.value ?? null,
    leak,
    at: now,
  });
  recordMatches(deps, effect);
  applyAddressEffects(deps, address, effect, senderAddr);

  return forwardTo
    ? { ...(await forwardDecision(deps, address, forwardTo, input.raw, email, rcpt.full, forwardOpts)), message_id: id }
    : { action: "store_only", message_id: id };
}
