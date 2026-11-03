import { eq } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { domains, type Domain } from "../../db/schema.js";
import { getMailbox, imapSettings, smtpSettings } from "./settings.js";

/**
 * Connection test of an IMAP domain: IMAP login + the folder exists, then SMTP verify when configured.
 * Never throws; the outcome is stored on the domain row (active or error with the message).
 */
export async function checkMailboxDomain(deps: Deps, domain: Domain): Promise<Domain> {
  const update: Partial<Domain> = { lastCheckedAt: deps.now(), dnsMissingJson: null };
  const m = getMailbox(deps, domain.id);
  if (!m) {
    Object.assign(update, { status: "error", statusDetail: "No mailbox settings: edit the domain and enter them." });
  } else {
    const parts: string[] = [];
    let step = "IMAP";
    try {
      const session = await deps.mail.imap.connect(imapSettings(deps, m));
      try {
        const box = await session.openFolder(m.imapFolder);
        parts.push(`IMAP login OK, folder "${m.imapFolder}" holds ${box.exists} message(s)`);
      } finally {
        await session.close().catch(() => {});
      }
      const smtp = smtpSettings(deps, m);
      step = "SMTP";
      if (smtp) {
        await deps.mail.smtp.verify(smtp);
        parts.push("SMTP login OK");
      } else parts.push("no SMTP server: mail is stored but not forwarded");
      Object.assign(update, { status: "active", statusDetail: `${parts.join("; ")}.` });
    } catch (e) {
      Object.assign(update, { status: "error", statusDetail: `${step}: ${(e as Error).message}` });
    }
  }
  deps.db.update(domains).set(update).where(eq(domains.id, domain.id)).run();
  deps.logger.info("mailbox checked", { component: "mailbox", domain: domain.name, status: update.status });
  return deps.db.select().from(domains).where(eq(domains.id, domain.id)).get()!;
}
