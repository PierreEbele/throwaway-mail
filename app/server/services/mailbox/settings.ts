import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { domainMailboxes } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import { badRequest } from "../../lib/errors.js";
import type { ImapSettings, SmtpSettings } from "./types.js";

export type DomainMailbox = typeof domainMailboxes.$inferSelect;

export const MIN_POLL_SECONDS = 15;

const host = z.string().trim().min(1).max(253);
const port = z.coerce.number().int().min(1).max(65535);
const optText = z.string().trim().max(254).nullable().optional();

/** Mailbox settings as sent by the web UI / API. Passwords are write-only: empty or missing keeps the stored one. */
export const mailboxInput = z.object({
  imap_host: host,
  imap_port: port.default(993),
  imap_tls: z.boolean().default(true),
  imap_user: z.string().trim().min(1).max(254),
  imap_password: z.string().max(1000).optional(),
  imap_folder: z.string().trim().min(1).max(200).default("INBOX"),
  /** Folder for processed mail; null (or "") deletes it instead. */
  imap_done_folder: z.string().trim().max(200).nullable().default("Processed"),
  smtp_host: host.nullable().optional(),
  smtp_port: port.default(465),
  smtp_security: z.enum(["tls", "starttls", "none"]).default("tls"),
  /** Defaults to imap_user / imap_password when empty. */
  smtp_user: optText,
  smtp_password: z.string().max(1000).optional(),
  smtp_from: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  poll_seconds: z.coerce.number().int().min(MIN_POLL_SECONDS).max(86400).default(60),
});
export type MailboxInput = z.infer<typeof mailboxInput>;

function appSecret(deps: Deps): string {
  const s = deps.config.APP_SECRET;
  if (!s)
    throw badRequest("APP_SECRET is not set: it is needed to store IMAP/SMTP passwords. Add it to .env (32+ characters) and restart.");
  return s;
}

/** Row values for an insert or update; `current` is the stored row when editing. */
export function mailboxValues(
  deps: Deps,
  input: MailboxInput,
  current?: DomainMailbox,
): Omit<DomainMailbox, "domainId" | "lastPollAt" | "lastPollError" | "lastUid" | "uidValidity"> {
  const secret = appSecret(deps);
  const imapPasswordEnc = input.imap_password ? encryptSecret(secret, input.imap_password) : current?.imapPasswordEnc;
  if (!imapPasswordEnc) throw badRequest("imap_password is required");
  const smtpHost = input.smtp_host || null;
  return {
    imapHost: input.imap_host,
    imapPort: input.imap_port,
    imapTls: input.imap_tls,
    imapUser: input.imap_user,
    imapPasswordEnc,
    imapFolder: input.imap_folder,
    imapDoneFolder: input.imap_done_folder || null,
    smtpHost,
    smtpPort: input.smtp_port,
    smtpSecurity: input.smtp_security,
    smtpUser: smtpHost ? input.smtp_user || null : null,
    smtpPasswordEnc: !smtpHost
      ? null
      : input.smtp_password
        ? encryptSecret(secret, input.smtp_password)
        : (current?.smtpPasswordEnc ?? null),
    smtpFrom: input.smtp_from || null,
    pollSeconds: input.poll_seconds,
  };
}

export function getMailbox(deps: Deps, domainId: string): DomainMailbox | null {
  return deps.db.select().from(domainMailboxes).where(eq(domainMailboxes.domainId, domainId)).get() ?? null;
}

export function imapSettings(deps: Deps, m: DomainMailbox): ImapSettings {
  return {
    host: m.imapHost,
    port: m.imapPort,
    tls: m.imapTls,
    user: m.imapUser,
    password: decryptSecret(appSecret(deps), m.imapPasswordEnc),
  };
}

/** SMTP settings (null when SMTP is not configured). User and password fall back to the IMAP login. */
export function smtpSettings(deps: Deps, m: DomainMailbox): SmtpSettings | null {
  if (!m.smtpHost) return null;
  const secret = appSecret(deps);
  const sameLogin = !m.smtpUser || m.smtpUser === m.imapUser;
  const passwordEnc = m.smtpPasswordEnc ?? (sameLogin ? m.imapPasswordEnc : null);
  return {
    host: m.smtpHost,
    port: m.smtpPort ?? 465,
    security: m.smtpSecurity ?? "tls",
    user: m.smtpUser || m.imapUser,
    password: passwordEnc ? decryptSecret(secret, passwordEnc) : null,
  };
}

/** API view: never contains passwords. */
export function mailboxOut(m: DomainMailbox) {
  return {
    imap_host: m.imapHost,
    imap_port: m.imapPort,
    imap_tls: m.imapTls,
    imap_user: m.imapUser,
    has_imap_password: !!m.imapPasswordEnc,
    imap_folder: m.imapFolder,
    imap_done_folder: m.imapDoneFolder,
    smtp_host: m.smtpHost,
    smtp_port: m.smtpPort,
    smtp_security: m.smtpSecurity,
    smtp_user: m.smtpUser,
    has_smtp_password: !!m.smtpPasswordEnc,
    smtp_from: m.smtpFrom,
    poll_seconds: m.pollSeconds,
    last_poll_at: m.lastPollAt,
    last_poll_error: m.lastPollError,
  };
}
