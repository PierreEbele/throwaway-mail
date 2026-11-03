import { eq } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { domainMailboxes, domains, type Domain } from "../../db/schema.js";
import { ingestMessage, type IngestResult } from "../ingest/index.js";
import { metrics } from "../metrics.js";
import { findRecipient, findSender } from "./recipient.js";
import { getMailbox, imapSettings, smtpSettings, type DomainMailbox } from "./settings.js";
import { SmtpError, type ImapSession, type SmtpSettings } from "./types.js";

/** Messages handled per poll; the rest waits for the next one. */
export const POLL_BATCH = 50;

export interface PollResult {
  processed: number;
  skipped: number;
}

/**
 * One pass over an IMAP domain's mailbox: every message with a UID above last_uid is ingested, forwarded over
 * SMTP when the decision says so, then moved to the done folder (or deleted). last_uid is saved after each
 * message, so a crash never processes a mail twice (ingest also drops duplicates by Message-ID).
 */
export async function pollMailbox(deps: Deps, domain: Domain): Promise<PollResult> {
  const m = getMailbox(deps, domain.id);
  if (!m) throw new Error("No mailbox settings");
  const log = deps.logger.child({ component: "mailbox", domain: domain.name });
  const result: PollResult = { processed: 0, skipped: 0 };
  try {
    const session = await deps.mail.imap.connect(imapSettings(deps, m));
    try {
      await pollFolder(deps, domain, m, session, result, log);
    } finally {
      await session.close().catch(() => {});
    }
    deps.db
      .update(domainMailboxes)
      .set({ lastPollAt: deps.now(), lastPollError: null })
      .where(eq(domainMailboxes.domainId, domain.id))
      .run();
    if (domain.status !== "active")
      deps.db
        .update(domains)
        .set({ status: "active", statusDetail: "Mailbox polled successfully." })
        .where(eq(domains.id, domain.id))
        .run();
    metrics.imapPolls.inc({ domain: domain.name, result: "ok" });
    return result;
  } catch (e) {
    const msg = (e as Error).message;
    log.warn("poll failed", { err: msg });
    deps.db
      .update(domainMailboxes)
      .set({ lastPollAt: deps.now(), lastPollError: msg })
      .where(eq(domainMailboxes.domainId, domain.id))
      .run();
    metrics.imapPolls.inc({ domain: domain.name, result: "error" });
    throw e;
  }
}

async function pollFolder(deps: Deps, domain: Domain, m: DomainMailbox, session: ImapSession, result: PollResult, log: Deps["logger"]) {
  const box = await session.openFolder(m.imapFolder);
  let lastUid = m.lastUid;
  if (m.uidValidity !== box.uidValidity) {
    // The server renumbered the folder: old UIDs mean nothing anymore.
    if (m.uidValidity !== null) log.warn("UIDVALIDITY changed, rescanning the folder", { old: m.uidValidity, new: box.uidValidity });
    lastUid = 0;
    deps.db.update(domainMailboxes).set({ uidValidity: box.uidValidity, lastUid: 0 }).where(eq(domainMailboxes.domainId, domain.id)).run();
  }
  const uids = (await session.uidsAfter(lastUid)).slice(0, POLL_BATCH);
  if (uids.length && m.imapDoneFolder) await session.ensureFolder(m.imapDoneFolder);
  const smtp = smtpSettings(deps, m);

  for (const uid of uids) {
    const raw = await session.fetchRaw(uid);
    const rcpt = raw ? findRecipient(raw, domain.name) : null;
    if (raw && rcpt) {
      const decision = await ingestMessage(deps, { raw, envelopeFrom: findSender(raw), envelopeTo: rcpt });
      metrics.ingest.inc({ action: decision.duplicate ? "duplicate" : decision.action, reason: decision.reason ?? "" });
      if (decision.action === "reject") log.info("rejected (nothing is bounced from a mailbox)", { uid, reason: decision.reason });
      await deliver(deps, smtp, m, rcpt, raw, decision, log);
    } else {
      log.info("skipped: no recipient on this domain", { uid });
    }
    deps.db.update(domainMailboxes).set({ lastUid: uid }).where(eq(domainMailboxes.domainId, domain.id)).run();
    if (!raw || !rcpt) {
      // Left in place: the mailbox may also receive mail that is not ours.
      result.skipped++;
      metrics.imapMessages.inc({ domain: domain.name, outcome: "skipped" });
      continue;
    }
    result.processed++;
    metrics.imapMessages.inc({ domain: domain.name, outcome: "processed" });
    try {
      if (m.imapDoneFolder) await session.move(uid, m.imapDoneFolder);
      else await session.remove(uid);
    } catch (e) {
      log.warn("could not move / delete a processed message", { uid, err: (e as Error).message });
    }
  }
}

/**
 * Carries out a forward decision over SMTP. The original message is sent unchanged (no header is added, so DKIM
 * signatures stay intact); the envelope sender is smtp_from, or the alias. A permanent SMTP error (5xx) is logged
 * and skipped; a temporary one aborts the poll so the message is retried (ingest replays the decision).
 */
async function deliver(
  deps: Deps,
  smtp: SmtpSettings | null,
  m: DomainMailbox,
  alias: string,
  raw: Uint8Array,
  decision: IngestResult,
  log: Deps["logger"],
) {
  if (decision.action !== "forward") return;
  const from = m.smtpFrom ?? alias;
  const jobs = [
    ...(decision.forward_to_all ?? (decision.forward_to ? [decision.forward_to] : [])).map((to) => ({ to, raw })),
    ...(decision.send ?? []).map((s) => ({ to: s.to, raw: Buffer.from(s.raw_base64, "base64") })),
  ];
  if (!smtp) {
    log.warn("forwarding skipped: no SMTP server configured", { targets: jobs.length });
    return;
  }
  for (const job of jobs) {
    try {
      await deps.mail.smtp.send(smtp, { from, to: [job.to] }, job.raw);
      metrics.imapForwards.inc({ result: "ok" });
    } catch (e) {
      metrics.imapForwards.inc({ result: "error" });
      if (e instanceof SmtpError && e.permanent) log.warn("forward refused by the SMTP server", { to: job.to, err: e.message });
      else throw new Error(`SMTP: ${(e as Error).message}`);
    }
  }
}
