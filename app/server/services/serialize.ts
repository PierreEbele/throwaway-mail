import { parseList } from "../lib/senders.js";
import type { Address, Destination, Domain, ExtractedItem, Message, User } from "../db/schema.js";

export function userOut(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, created_at: u.createdAt, last_login_at: u.lastLoginAt };
}

export function domainOut(d: Domain, full: boolean, owner?: { id: string; name: string | null; email: string } | null) {
  const base = { id: d.id, name: d.name, status: d.status, unknown_policy: d.unknownPolicy };
  if (!full) return base;
  return {
    ...base,
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
    cf_zone_id: d.cfZoneId,
    status_detail: d.statusDetail,
    dns_missing: d.dnsMissingJson ? JSON.parse(d.dnsMissingJson) : [],
    previous_catch_all: d.previousCatchAllJson ? JSON.parse(d.previousCatchAllJson) : null,
    catchall_forward_to: d.catchallForwardTo,
    created_at: d.createdAt,
    last_checked_at: d.lastCheckedAt,
  };
}

export function destinationOut(d: Destination) {
  return { id: d.id, email: d.email, verified: !!d.verifiedAt, verified_at: d.verifiedAt, last_error: d.lastError, created_at: d.createdAt };
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
    alternatives: codes.filter((c) => c !== best).map((c) => ({ value: c.value, confidence: c.confidence, method: c.method, raw: c.label })),
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
    attachments: m.attachmentsJson ? (JSON.parse(m.attachmentsJson) as Array<{ filename: string | null; mime_type: string; size: number; inline: boolean }>) : [],
    preview,
    trackers_removed: m.trackersRemoved,
    auth_warning: m.authWarning,
    is_bulk: m.isBulk,
    unsubscribe: m.unsubscribeUrl || m.unsubscribeMailto ? { url: m.unsubscribeUrl, mailto: m.unsubscribeMailto, one_click: m.unsubscribeOneClick, done_at: m.unsubscribedAt } : null,
    code: ex.code?.value ?? null,
    has_links: ex.links.length > 0,
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
    extracted: itemsOut(items),
  };
}
