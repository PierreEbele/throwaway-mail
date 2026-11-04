import { and, eq, inArray, sql } from "drizzle-orm";
import addressparser from "nodemailer/lib/addressparser/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Deps } from "../context.js";
import { addresses, domains, reverseContacts, type Address, type Domain, type User } from "../db/schema.js";
import { randomToken } from "../lib/crypto.js";
import { SlidingWindowLimiter } from "../auth/ratelimit.js";
import { SmtpError } from "./mailbox/types.js";
import { REVERSE_LOCAL_RE, contactFor, displayName, field, join, outboundFor, split, type Field } from "./replies.js";
import { audit } from "./audit.js";
import { notify } from "./notify.js";

/**
 * New mail sent from an alias (SMTP submission server, compose dialog, API). The From header must be one of the
 * user's active aliases; recipients may be plain addresses or reverse addresses (r+token@domain) of that alias's
 * contacts. Headers that could identify the user are dropped, every recipient becomes a reverse contact (so the
 * answer, sent to the alias, is forwarded with a reply address), and the mail leaves through the same outbound
 * path as reverse-alias replies.
 */

export type SendErrorCode = "invalid" | "forbidden" | "rate_limited" | "unavailable" | "failed";

export class SendError extends Error {
  constructor(
    message: string,
    readonly code: SendErrorCode,
    /** Seconds (rate_limited) */
    readonly retryAfter = 0,
    /** The relay refused the mail for good (5xx). */
    readonly permanent = false,
  ) {
    super(message);
  }
}

export interface SendResult {
  address_id: string;
  from: string;
  to: string[];
  message_id: string;
  via: "mailbox" | "relay";
}

export type SendChannel = "smtp" | "api" | "web";

const limiters = new WeakMap<Deps, SlidingWindowLimiter>();
function limiter(deps: Deps) {
  let l = limiters.get(deps);
  if (!l) limiters.set(deps, (l = new SlidingWindowLimiter(deps.config.SEND_RATE_LIMIT_PER_HOUR, 3600_000)));
  return l;
}

/** Headers of the user's mail that may leave the app; everything else (Received, User-Agent, X-Originating-IP...) is dropped. */
const SEND_KEEP = new Set([
  "to",
  "cc",
  "subject",
  "date",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-language",
]);

const unfold = (f: Field) =>
  f.text
    .slice(f.text.indexOf(":") + 1)
    .replace(/\r\n[ \t]/g, " ")
    .trim();

function parseAddresses(value: string): Array<{ name: string; address: string }> {
  return addressparser(value, { flatten: true })
    .filter((a) => a.address)
    .map((a) => ({ name: a.name, address: a.address.toLowerCase() }));
}

/** The user's alias with this exact address, with its domain. */
function findAlias(deps: Deps, user: User, email: string): { a: Address; domain: Domain } | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const row = deps.db
    .select({ a: addresses, domain: domains })
    .from(addresses)
    .innerJoin(domains, eq(domains.id, addresses.domainId))
    .where(
      and(
        eq(addresses.userId, user.id),
        eq(addresses.localPart, email.slice(0, at).toLowerCase()),
        eq(sql`lower(${domains.name})`, email.slice(at + 1).toLowerCase()),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Validates, rewrites and relays one mail written by `user`. `envelopeTo` (SMTP submission) overrides the
 * recipients read from To / Cc / Bcc. Throws SendError.
 */
export async function sendFromAlias(
  deps: Deps,
  user: User,
  raw: Uint8Array,
  opts: { envelopeTo?: string[]; channel: SendChannel; ip?: string | null },
): Promise<SendResult> {
  const { fields, body } = split(raw);
  const fromField = fields.find((f) => f.name === "from");
  const from = fromField ? parseAddresses(unfold(fromField)) : [];
  if (from.length !== 1) throw new SendError("The mail needs exactly one From address", "invalid");
  const alias = findAlias(deps, user, from[0]!.address);
  if (!alias) throw new SendError(`${from[0]!.address} is not one of your aliases`, "forbidden");
  const { a: address, domain } = alias;
  if (address.status !== "active") throw new SendError(`${from[0]!.address} is ${address.status}: it cannot send mail`, "forbidden");
  const aliasEmail = `${address.localPart}@${domain.name}`;

  // Recipients: the SMTP envelope, else To / Cc / Bcc.
  const names = new Map<string, string>();
  for (const f of fields.filter((x) => ["to", "cc", "bcc"].includes(x.name)))
    for (const p of parseAddresses(unfold(f))) if (p.name) names.set(p.address, p.name);
  const listed = opts.envelopeTo?.length
    ? opts.envelopeTo.map((e) => e.toLowerCase())
    : fields.filter((x) => ["to", "cc", "bcc"].includes(x.name)).flatMap((f) => parseAddresses(unfold(f)).map((p) => p.address));
  const wanted = [...new Set(listed)];
  if (!wanted.length) throw new SendError("No recipient", "invalid");
  if (wanted.length > deps.config.SEND_MAX_RECIPIENTS)
    throw new SendError(`At most ${deps.config.SEND_MAX_RECIPIENTS} recipients per mail`, "invalid");

  // Reverse addresses of this alias's contacts stand for the contact's real address.
  const ownDomains = new Set(
    deps.db
      .select({ name: domains.name })
      .from(domains)
      .all()
      .map((d) => d.name.toLowerCase()),
  );
  const reverseTokens = new Map<string, string>();
  for (const r of wanted) {
    const [local, dom] = [r.slice(0, r.lastIndexOf("@")), r.slice(r.lastIndexOf("@") + 1)];
    const m = REVERSE_LOCAL_RE.exec(local);
    if (m && ownDomains.has(dom)) reverseTokens.set(r, m[1]!);
  }
  const contacts = reverseTokens.size
    ? deps.db
        .select()
        .from(reverseContacts)
        .where(inArray(reverseContacts.token, [...reverseTokens.values()]))
        .all()
    : [];
  const rewrite = new Map<string, string>();
  for (const [r, token] of reverseTokens) {
    const c = contacts.find((x) => x.token === token);
    if (!c || c.addressId !== address.id) throw new SendError(`${r} is not a contact of ${aliasEmail}`, "forbidden");
    if (c.blocked) throw new SendError(`${c.email} is blocked for ${aliasEmail}`, "forbidden");
    rewrite.set(r, c.email);
    if (c.name) names.set(c.email, c.name);
  }
  const recipients = [...new Set(wanted.map((r) => rewrite.get(r) ?? r))];

  const out = outboundFor(deps, domain);
  if (!out) throw new SendError("No outbound SMTP server for this domain (an admin must set SMTP_RELAY_URL)", "unavailable");
  const now = deps.now();
  const wait = limiter(deps).hit(user.id, now);
  if (wait) throw new SendError(`Sending limit reached (${deps.config.SEND_RATE_LIMIT_PER_HOUR} mails per hour)`, "rate_limited", wait);

  const messageId = `<${randomToken(16)}@${domain.name}>`;
  const kept = fields
    .filter((f) => SEND_KEEP.has(f.name))
    .map((f) => {
      if (f.name !== "to" && f.name !== "cc") return f;
      let text = f.text;
      for (const [r, real] of rewrite) text = text.replace(new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), real);
      return { ...f, text };
    });
  if (!kept.some((f) => f.name === "date")) kept.push(field("Date", new Date(now).toUTCString()));
  if (!kept.some((f) => f.name === "to") && !kept.some((f) => f.name === "cc")) kept.push(field("To", "undisclosed-recipients:;"));
  const shownName = from[0]!.name;
  const mime = join(
    [field("From", shownName ? `${displayName(shownName)} <${aliasEmail}>` : `<${aliasEmail}>`), field("Message-ID", messageId), ...kept],
    body,
  );

  const log = deps.logger.child({ component: "sending" });
  try {
    await deps.mail.smtp.send(out.settings, { from: out.envelopeFrom ?? aliasEmail, to: recipients }, mime);
  } catch (e) {
    const permanent = e instanceof SmtpError && e.permanent;
    log.warn("mail could not be sent", { address_id: address.id, err: (e as Error).message, permanent });
    throw new SendError(`The outbound server refused the mail: ${(e as Error).message}`, "failed", 0, permanent);
  }
  for (const r of recipients) contactFor(deps, address, r, names.get(r) ?? null);
  audit(deps, user.id, "mail.sent", address.id, { to: recipients.length, channel: opts.channel, via: out.via }, opts.ip ?? null);
  log.info("mail sent from alias", { address_id: address.id, recipients: recipients.length, channel: opts.channel, via: out.via });
  const subjectField = fields.find((f) => f.name === "subject");
  void notify(deps, user.id, {
    type: "message.sent",
    title: `Sent from ${address.siteName}`,
    body: `${aliasEmail} → ${recipients.join(", ")}`,
    url: `${deps.config.APP_URL.replace(/\/$/, "")}/addresses/${address.id}`,
    data: {
      address_id: address.id,
      address: aliasEmail,
      site: address.siteName,
      to: recipients,
      subject: subjectField ? unfold(subjectField) : null,
      message_id: messageId,
      channel: opts.channel,
    },
  }).catch(() => {});
  return { address_id: address.id, from: aliasEmail, to: recipients, message_id: messageId, via: out.via };
}

export interface ComposedMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Display name shown next to the alias. */
  from_name?: string;
  in_reply_to?: string;
}

/** Builds the MIME of a mail written in the web UI or sent through the API, then sends it like any other. */
export async function sendComposed(
  deps: Deps,
  user: User,
  address: Address,
  domainName: string,
  mail: ComposedMail,
  channel: SendChannel,
  ip?: string | null,
): Promise<SendResult> {
  const aliasEmail = `${address.localPart}@${domainName}`;
  const raw = await new MailComposer({
    from: mail.from_name ? { name: mail.from_name, address: aliasEmail } : aliasEmail,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.in_reply_to,
    references: mail.in_reply_to,
  })
    .compile()
    .build();
  const envelopeTo = [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])];
  return sendFromAlias(deps, user, raw, { envelopeTo, channel, ip });
}
