import { addressFallbackIds } from "./ingest/forwarding.js";
import { parseList } from "../lib/senders.js";
import type { Address, Destination, Domain, ExtractedItem, Message, User } from "../db/schema.js";

export function userOut(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    /** "local": e-mail + password, role managed in the app; "sso": role follows identity-provider groups. */
    auth: u.oidcSub === null ? ("local" as const) : ("sso" as const),
    disabled: u.disabled,
    /** Local accounts only: TOTP second factor turned on. */
    two_factor: u.totpEnabledAt !== null && !!u.totpSecret,
    created_at: u.createdAt,
    last_login_at: u.lastLoginAt,
    /** Domain of new addresses when none is given: "first", "random" or "rotate". */
    domain_choice: u.domainChoice,
    /** Minutes after which an address that received nothing is flagged (0: never). */
    no_mail_warn_minutes: u.noMailWarnMinutes,
  };
}

export function domainOut(d: Domain, full: boolean, owner?: { id: string; name: string | null; email: string } | null) {
  const base = { id: d.id, name: d.name, transport: d.transport, status: d.status, unknown_policy: d.unknownPolicy };
  if (!full) return base;
  return {
    ...base,
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
    cf_zone_id: d.cfZoneId,
    status_detail: d.statusDetail,
    dns_missing: d.dnsMissingJson ? JSON.parse(d.dnsMissingJson) : [],
    previous_catch_all: d.previousCatchAllJson ? JSON.parse(d.previousCatchAllJson) : null,
    catchall_forward_to: d.catchallForwardTo,
    auto_create_user_id: d.autoCreateUserId,
    auto_create_category_id: d.autoCreateCategoryId,
    created_at: d.createdAt,
    last_checked_at: d.lastCheckedAt,
    last_ingest_at: d.lastIngestAt,
  };
}

export function destinationOut(d: Destination) {
  return {
    id: d.id,
    email: d.email,
    verified: !!d.verifiedAt,
    verified_at: d.verifiedAt,
    last_error: d.lastError,
    created_at: d.createdAt,
    pgp: d.pgpFingerprint ? { fingerprint: d.pgpFingerprint, hide_subject: d.pgpHideSubject } : null,
    /** "app": verified through a link e-mailed by the app (no Cloudflare); "cloudflare": by Cloudflare Email Routing. */
    verification: d.verifyTokenHash ? ("app" as const) : ("cloudflare" as const),
    verify_sent_at: d.verifySentAt,
    /** Position in the fallback chain (null: not a fallback). */
    fallback_position: d.fallbackPosition,
  };
}

export function addressOut(a: Address, domainName: string, counts?: { unread: number; total: number }) {
  return {
    id: a.id,
    email: `${a.localPart}@${domainName}`,
    local_part: a.localPart,
    domain: domainName,
    domain_id: a.domainId,
    site_name: a.siteName,
    site_url: a.siteUrl,
    label: a.label,
    forward_enabled: a.forwardEnabled,
    destination_id: a.destinationId,
    status: a.status,
    is_unassigned: a.isUnassigned,
    expires_at: a.expiresAt,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    last_message_at: a.lastMessageAt,
    category_id: a.categoryId,
    pinned: a.pinned,
    blocked_senders: parseList(a.blockedSendersJson),
    trusted_senders: parseList(a.trustedSendersJson),
    block_promos: a.blockPromos,
    site_lock: a.siteLock,
    feed_token: a.feedToken,
    max_messages: a.maxMessages,
    burn_after_code: a.burnAfterCode,
    replies_enabled: a.repliesEnabled,
    fallback_destination_ids: addressFallbackIds(a),
    burned: a.burnReason ? { reason: a.burnReason, at: a.burnedAt } : null,
    leak: a.leakSender ? { sender: a.leakSender, at: a.leakAt } : null,
    unread_count: counts?.unread ?? 0,
    message_count: counts?.total ?? 0,
  };
}

export function itemsOut(items: ExtractedItem[]) {
  const codes = items.filter((i) => i.kind === "code").sort((a, b) => a.rank - b.rank);
  const links = items.filter((i) => i.kind === "link").sort((a, b) => a.rank - b.rank);
  const best = codes.find((c) => c.rank === 0);
  return {
    code: best ? { value: best.value, confidence: best.confidence, method: best.method, raw: best.label } : null,
    alternatives: codes
      .filter((c) => c !== best)
      .map((c) => ({ value: c.value, confidence: c.confidence, method: c.method, raw: c.label })),
    links: links.map((l) => ({ url: l.value, label: l.label, confidence: l.confidence, method: l.method })),
  };
}

export function messageSummaryOut(m: Message, items: ExtractedItem[]) {
  const ex = itemsOut(items);
  const preview = (m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    id: m.id,
    address_id: m.addressId,
    from: m.fromAddr,
    from_name: m.fromName,
    subject: m.subject,
    received_at: m.receivedAt,
    read_at: m.readAt,
    archived_at: m.archivedAt,
    forwarded: m.forwarded,
    attachments: m.attachmentsJson
      ? (JSON.parse(m.attachmentsJson) as Array<{ filename: string | null; mime_type: string; size: number; inline: boolean }>)
      : [],
    preview,
    trackers_removed: m.trackersRemoved,
    auth_warning: m.authWarning,
    is_bulk: m.isBulk,
    unsubscribe:
      m.unsubscribeUrl || m.unsubscribeMailto
        ? { url: m.unsubscribeUrl, mailto: m.unsubscribeMailto, one_click: m.unsubscribeOneClick, done_at: m.unsubscribedAt }
        : null,
    code: ex.code?.value ?? null,
    has_links: ex.links.length > 0,
    quarantined_at: m.quarantinedAt,
    matched_rules: m.matchedRulesJson ? (JSON.parse(m.matchedRulesJson) as Array<{ id: string; name: string }>) : [],
  };
}

export function messageOut(m: Message, items: ExtractedItem[]) {
  return {
    ...messageSummaryOut(m, items),
    envelope_from: m.envelopeFrom,
    envelope_to: m.envelopeTo,
    forward_to: m.forwardTo,
    raw_size: m.rawSize,
    auth: { spf: m.spf, dkim: m.dkim, dmarc: m.dmarc },
    text: m.text,
    html: m.html,
    headers: m.headersJson ? JSON.parse(m.headersJson) : [],
    /** The original header section as received (null for mail stored before it was kept). */
    raw_headers: m.rawHeaders,
    extracted: itemsOut(items),
  };
}
