import type { Deps } from "../../context.js";
import type { Domain } from "../../db/schema.js";
import { checkMailboxDomain } from "../mailbox/check.js";
import { getMailbox } from "../mailbox/settings.js";
import { DAY, QUIET_DAYS, ago, msg, type Check } from "./types.js";
export function lastMailCheck(deps: Deps, d: Domain): Check {
  const now = deps.now();
  const id = `domain.last_mail:${d.name}`;
  const title = `${d.name}: last mail received`;
  if (!d.lastIngestAt)
    return {
      id,
      group: "domains",
      title,
      status: "warn",
      detail: "No mail received yet",
      hint: "Create an address and send it a test mail. If it never arrives, check the other checks of this domain and the Worker logs (`npx wrangler tail`).",
    };
  if (now - d.lastIngestAt > QUIET_DAYS * DAY)
    return {
      id,
      group: "domains",
      title,
      status: "warn",
      detail: `Last mail ${ago(now, d.lastIngestAt)}`,
      hint: "Nothing for a while: normal if the domain is little used, otherwise send a test mail.",
    };
  return { id, group: "domains", title, status: "ok", detail: `Last mail ${ago(now, d.lastIngestAt)}` };
}

export async function imapDomainChecks(deps: Deps, d: Domain): Promise<Check[]> {
  const out: Check[] = [];
  const checked = await checkMailboxDomain(deps, d).catch((e: unknown) => ({ ...d, status: "error" as const, statusDetail: msg(e) }));
  out.push(
    checked.status === "active"
      ? {
          id: `domain.mailbox:${d.name}`,
          group: "domains",
          title: `${d.name}: IMAP/SMTP mailbox`,
          status: "ok",
          detail: checked.statusDetail ?? "Connected",
        }
      : {
          id: `domain.mailbox:${d.name}`,
          group: "domains",
          title: `${d.name}: IMAP/SMTP mailbox`,
          status: "error",
          detail: checked.statusDetail ?? "Connection failed",
          hint: "Edit the domain in Admin → Domains: check host, port, TLS, user name and password (an app password if the provider uses 2FA).",
        },
  );
  const m = getMailbox(deps, d.id);
  if (m?.lastPollError)
    out.push({
      id: `domain.poll:${d.name}`,
      group: "domains",
      title: `${d.name}: polling`,
      status: "warn",
      detail: `Last poll failed: ${m.lastPollError}`,
      hint: "The app retries on its own; if this persists, check the mailbox settings.",
    });
  return out;
}
