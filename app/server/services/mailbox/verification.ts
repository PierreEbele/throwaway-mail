import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { destinations, domainMailboxes, domains, type Destination } from "../../db/schema.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { smtpSettings } from "./settings.js";

/** How long an e-mailed verification link stays valid. */
export const VERIFY_TTL_MS = 48 * 3600_000;

/**
 * Destinations are verified by the app itself (instead of Cloudflare) when Cloudflare is not configured or the
 * user asked for it; such a destination has no Cloudflare id but a token hash.
 */
export function usesAppVerification(deps: Deps, d: Destination): boolean {
  return deps.cf.mode === "unconfigured" || (!d.cfDestinationId && !!d.verifyTokenHash);
}

/** The first active IMAP domain with SMTP configured: it sends the verification mail. */
function senderMailbox(deps: Deps) {
  return deps.db
    .select({ name: domains.name, mailbox: domainMailboxes })
    .from(domains)
    .innerJoin(domainMailboxes, eq(domainMailboxes.domainId, domains.id))
    .where(and(eq(domains.transport, "imap"), eq(domains.status, "active"), isNotNull(domainMailboxes.smtpHost)))
    .orderBy(asc(domains.createdAt))
    .get();
}

function verificationMail(from: string, to: string, link: string, now: number): string {
  const host = from.split("@")[1] ?? "localhost";
  return [
    `From: Throwaway Mail <${from}>`,
    `To: <${to}>`,
    "Subject: Confirm this forwarding address",
    `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${randomToken(12)}@${host}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "Auto-Submitted: auto-generated",
    "",
    `Someone (hopefully you) added ${to} as a forwarding destination in Throwaway Mail.`,
    "",
    "Open this link within 48 hours to confirm it:",
    link,
    "",
    "If you did not ask for this, ignore this message: nothing will be forwarded to you.",
    "",
  ].join("\r\n");
}

/** E-mails a fresh one-time link (the previous one stops working). Never throws: errors end up in last_error. */
export async function sendAppVerification(deps: Deps, d: Destination): Promise<Destination> {
  const token = randomToken(32);
  const set: Partial<Destination> = { verifyTokenHash: sha256(token), verifySentAt: null, lastError: null };
  const sender = senderMailbox(deps);
  if (!sender) {
    set.lastError =
      "No verification mail could be sent: an admin must first add an active IMAP domain with an SMTP server (Admin → Domains).";
  } else {
    const m = sender.mailbox;
    const from = m.smtpFrom ?? (m.imapUser.includes("@") ? m.imapUser : `noreply@${sender.name}`);
    const link = `${deps.config.APP_URL.replace(/\/$/, "")}/v1/destinations/verify/${token}`;
    try {
      const raw = Buffer.from(verificationMail(from, d.email, link, deps.now()), "utf8");
      await deps.mail.smtp.send(smtpSettings(deps, m)!, { from, to: [d.email] }, raw);
      set.verifySentAt = deps.now();
    } catch (e) {
      set.lastError = `Could not send the verification mail: ${(e as Error).message}`;
    }
  }
  deps.db.update(destinations).set(set).where(eq(destinations.id, d.id)).run();
  return deps.db.select().from(destinations).where(eq(destinations.id, d.id)).get()!;
}

/**
 * Marks the destination of a valid, unexpired token as verified. Clearing verify_sent_at makes the token single-use;
 * the hash stays as the marker of app verification.
 */
export function confirmAppVerification(deps: Deps, token: string): Destination | null {
  const d = deps.db
    .select()
    .from(destinations)
    .where(eq(destinations.verifyTokenHash, sha256(token)))
    .get();
  if (!d?.verifySentAt || deps.now() - d.verifySentAt > VERIFY_TTL_MS) return null;
  deps.db.update(destinations).set({ verifiedAt: deps.now(), verifySentAt: null, lastError: null }).where(eq(destinations.id, d.id)).run();
  return deps.db.select().from(destinations).where(eq(destinations.id, d.id)).get()!;
}
