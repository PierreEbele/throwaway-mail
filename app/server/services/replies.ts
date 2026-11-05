import crypto from "node:crypto";
import PostalMime from "postal-mime";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, destinations, domains, reverseContacts, type Address, type Domain, type ReverseContact } from "../db/schema.js";
import { newId, randomToken } from "../lib/crypto.js";
import { authResult } from "./ingest/auth.js";
import type { IngestInput, IngestResult } from "./ingest/types.js";
import { getMailbox, smtpSettings } from "./mailbox/settings.js";
import type { SmtpSettings } from "./mailbox/types.js";
import { audit } from "./audit.js";
import { relayTransport, smtpTransport, type OutboundTransport } from "./transport.js";

/**
 * Reverse-alias replies. Mail forwarded for an address with replies enabled is rewritten: From becomes the alias
 * (so the Worker / SMTP server may send it), Reply-To becomes r+<token>@<domain>, one token per external sender.
 * A reply from one of the user's verified destinations to that address is stripped of the user's identity and
 * sent from the alias to the original sender over SMTP (the domain's mailbox SMTP server, or SMTP_RELAY_URL).
 */

/** r+<24 hex>@domain: hex survives providers that lower-case addresses. */
export const REVERSE_LOCAL_RE = /^r\+([0-9a-f]{24})$/;

export interface Outbound {
  transport: OutboundTransport;
  /** Envelope sender to use instead of the alias (mailbox smtp_from / SMTP_RELAY_FROM). */
  envelopeFrom: string | null;
  via: "mailbox" | "relay";
}

/** Parses SMTP_RELAY_URL. */
export function relaySettings(url: string | undefined): SmtpSettings | null {
  if (!url) return null;
  const u = new URL(url);
  const implicit = u.protocol === "smtps:";
  const none = u.searchParams.get("tls") === "none";
  return {
    host: u.hostname,
    port: Number(u.port) || (implicit ? 465 : 587),
    security: implicit ? "tls" : none ? "none" : "starttls",
    user: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
  };
}

/** How mail leaves for an arbitrary recipient from this domain; null: replies are impossible. */
export function outboundFor(deps: Deps, domain: Domain): Outbound | null {
  if (domain.transport === "imap") {
    const m = getMailbox(deps, domain.id);
    try {
      const s = m ? smtpSettings(deps, m) : null;
      if (s) return { transport: smtpTransport(deps.mail.smtp, s), envelopeFrom: m!.smtpFrom, via: "mailbox" };
    } catch {
      // APP_SECRET missing: fall through to the relay.
    }
  }
  const relay = relayTransport(deps, relaySettings(deps.config.SMTP_RELAY_URL));
  if (!relay) return null;
  // Cloudflare Email Sending only accepts envelope senders on onboarded domains: the alias itself.
  const envelopeFrom = relay.kind === "smtp" ? (deps.config.SMTP_RELAY_FROM ?? null) : null;
  return { transport: relay, envelopeFrom, via: "relay" };
}

/** Why replies cannot be enabled for this domain (null: they can). */
export function repliesUnavailableReason(deps: Deps, domain: Domain): string | null {
  if (outboundFor(deps, domain)) return null;
  return domain.transport === "imap"
    ? "This domain's mailbox has no SMTP server and no outbound transport is set (SMTP_RELAY_URL or OUTBOUND_TRANSPORT=cloudflare): replies cannot be sent."
    : "No outbound transport: an admin must set SMTP_RELAY_URL or OUTBOUND_TRANSPORT=cloudflare (Email Routing alone can only send to verified destinations).";
}

/** The contact of (address, sender), created on first use. */
export function contactFor(deps: Deps, address: Address, email: string, name: string | null): ReverseContact {
  const lower = email.toLowerCase();
  deps.db
    .insert(reverseContacts)
    .values({
      id: newId("rvc"),
      addressId: address.id,
      email: lower,
      name: name || null,
      token: crypto.randomBytes(12).toString("hex"),
      createdAt: deps.now(),
    })
    .onConflictDoNothing()
    .run();
  return deps.db
    .select()
    .from(reverseContacts)
    .where(and(eq(reverseContacts.addressId, address.id), eq(reverseContacts.email, lower)))
    .get()!;
}

// --- MIME header surgery -------------------------------------------------------------------------------------------

export interface Field {
  name: string;
  /** Raw field text including folding, without the final CRLF. */
  text: string;
}

export function split(raw: Uint8Array): { fields: Field[]; body: Buffer } {
  const buf = Buffer.from(raw);
  const text = buf.toString("latin1");
  const m = /\r?\n\r?\n/.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  const body = m ? buf.subarray(m.index + m[0].length) : Buffer.alloc(0);
  const fields: Field[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && fields.length) fields.at(-1)!.text += "\r\n" + line;
    else {
      const i = line.indexOf(":");
      if (i > 0) fields.push({ name: line.slice(0, i).trim().toLowerCase(), text: line });
    }
  }
  return { fields, body };
}

export function join(fields: Field[], body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(fields.map((f) => f.text).join("\r\n") + "\r\n\r\n", "latin1"), body]);
}

/** A display name as a quoted string, or an RFC 2047 encoded word when it is not plain ASCII. */
export function displayName(name: string): string {
  const clean = name.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return `"${clean.replace(/(["\\])/g, "\\$1")}"`;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export const field = (name: string, value: string): Field => ({ name: name.toLowerCase(), text: `${name}: ${value}` });

/** Headers that would let the recipient (or the user's mail client) bypass the alias. */
export const FORWARD_DROP = new Set(["from", "reply-to", "sender", "return-path", "dkim-signature", "x-original-from", "mail-followup-to"]);

/** The forwarded copy: From the alias, Reply-To the reverse address, the original sender kept in X-Original-From. */
export function rewriteForward(
  raw: Uint8Array,
  o: { alias: string; reverse: string; senderEmail: string; senderName: string | null },
): Buffer {
  const { fields, body } = split(raw);
  const shown = displayName(o.senderName ? `${o.senderName} (${o.senderEmail})` : o.senderEmail);
  const kept = fields.filter((f) => !FORWARD_DROP.has(f.name) && !f.name.startsWith("arc-"));
  return join(
    [
      field("From", `${shown} <${o.alias}>`),
      field("Reply-To", `${shown} <${o.reverse}>`),
      field("X-Original-From", o.senderEmail),
      ...kept,
    ],
    body,
  );
}

/** The only headers of the user's reply that leave the app (everything else may identify the user). */
const REPLY_KEEP = new Set(["subject", "date", "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding"]);

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The outgoing reply: From the alias, To the contact, a new Message-ID; the user's addresses replaced in the body. */
export function rewriteReply(
  raw: Uint8Array,
  o: { alias: string; contact: ReverseContact; reverse: string; userEmails: string[]; now: number },
): Buffer {
  const { fields, body } = split(raw);
  const host = o.alias.split("@")[1]!;
  const kept = fields.filter((f) => REPLY_KEEP.has(f.name));
  if (!kept.some((f) => f.name === "date")) kept.push(field("Date", new Date(o.now).toUTCString()));
  let text = body.toString("latin1");
  // Quoted headers ("... <r+token@domain> wrote:") and signatures: best effort for plain / quoted-printable bodies.
  text = text.replace(new RegExp(escapeRe(o.reverse), "gi"), o.contact.email);
  for (const e of o.userEmails) text = text.replace(new RegExp(escapeRe(e), "gi"), o.alias);
  return join(
    [
      field("From", `<${o.alias}>`),
      field("To", o.contact.name ? `${displayName(o.contact.name)} <${o.contact.email}>` : `<${o.contact.email}>`),
      field("Message-ID", `<${randomToken(16)}@${host}>`),
      ...kept,
    ],
    Buffer.from(text, "latin1"),
  );
}

// --- Inbound replies ----------------------------------------------------------------------------------------------

/** A mail sent to r+<token>@<domain>: relay it to the contact when it really comes from the address's owner. */
export async function handleReply(deps: Deps, domain: Domain, token: string, input: IngestInput): Promise<IngestResult> {
  const log = deps.logger.child({ component: "replies", domain: domain.name });
  const row = deps.db
    .select({ c: reverseContacts, a: addresses })
    .from(reverseContacts)
    .innerJoin(addresses, eq(addresses.id, reverseContacts.addressId))
    .where(and(eq(reverseContacts.token, token), eq(addresses.domainId, domain.id)))
    .get();
  if (!row) {
    log.info("reject: unknown reverse address");
    return { action: "reject", reason: "unknown_recipient" };
  }
  const { c: contact, a: address } = row;
  const email = await PostalMime.parse(input.raw);
  const from = email.from?.address?.toLowerCase() ?? "";
  const verified = deps.db
    .select({ email: destinations.email })
    .from(destinations)
    .where(and(eq(destinations.userId, address.userId), isNotNull(destinations.verifiedAt)))
    .all()
    .map((d) => d.email.toLowerCase());
  const auth = {
    spf: authResult(email.headers, "spf"),
    dkim: authResult(email.headers, "dkim"),
    dmarc: authResult(email.headers, "dmarc"),
  };
  const authenticated = auth.dmarc === "pass" || (auth.dmarc !== "fail" && (auth.dkim === "pass" || auth.spf === "pass"));
  const deny = (reason: string, detail: string) => {
    log.warn(`reply refused: ${detail}`, { address_id: address.id, from, ...auth });
    audit(deps, address.userId, "reply.refused", address.id, { from, detail, ...auth }, null);
    return { action: "reject" as const, reason };
  };
  if (!verified.includes(from)) return deny("reply_not_allowed", "sender is not a verified destination");
  if (deps.config.REPLY_REQUIRE_AUTH && !authenticated) return deny("reply_not_allowed", "sender not authenticated (SPF/DKIM/DMARC)");
  if (!address.repliesEnabled || address.status !== "active") return deny("replies_disabled", "replies are off for this address");
  if (contact.blocked) return deny("replies_disabled", "contact blocked");
  const out = outboundFor(deps, domain);
  if (!out) return deny("replies_unavailable", "no outbound SMTP server");

  const alias = `${address.localPart}@${domain.name}`;
  const reverse = `r+${token}@${domain.name}`;
  const mime = rewriteReply(input.raw, { alias, contact, reverse, userEmails: verified, now: deps.now() });
  try {
    await out.transport.send({ from: out.envelopeFrom ?? alias, to: [contact.email] }, mime);
  } catch (e) {
    log.error("reply could not be sent", { address_id: address.id, err: (e as Error).message });
    return { action: "reject", reason: "reply_failed" };
  }
  deps.db
    .update(reverseContacts)
    .set({ lastReplyAt: deps.now(), replyCount: sql`${reverseContacts.replyCount} + 1` })
    .where(eq(reverseContacts.id, contact.id))
    .run();
  log.info("reply sent from alias", { address_id: address.id, contact_id: contact.id, via: out.via });
  return { action: "store_only", reason: "reply_sent" };
}

/** Domain of an address (for routes that only have the address row). */
export function domainOf(deps: Deps, address: Address): Domain {
  return deps.db.select().from(domains).where(eq(domains.id, address.domainId)).get()!;
}
