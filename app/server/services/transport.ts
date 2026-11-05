import type { Deps } from "../context.js";
import { CloudflareError, type CloudflareClient } from "../cloudflare/index.js";
import { SmtpError, type SmtpEnvelope, type SmtpSender, type SmtpSettings } from "./mailbox/types.js";

/**
 * Where outbound mail (reverse-alias replies, mail sent from an alias, forwarding from the app) leaves. Every
 * implementation sends the MIME unchanged with the given envelope and throws SmtpError on failure, with
 * `permanent` set when retrying the same message cannot help.
 */
export interface OutboundTransport {
  readonly kind: "smtp" | "cloudflare";
  send(envelope: SmtpEnvelope, raw: Uint8Array): Promise<void>;
}

/** An SMTP server (a domain's mailbox SMTP or SMTP_RELAY_URL). */
export function smtpTransport(sender: SmtpSender, settings: SmtpSettings): OutboundTransport {
  return { kind: "smtp", send: (envelope, raw) => sender.send(settings, envelope, raw) };
}

/**
 * Cloudflare Email Sending through the REST API (send_raw): the app already builds complete MIME messages, so the
 * raw endpoint relays them as they are. The mock client (CF_MOCK, tests) records them instead.
 */
export function cloudflareTransport(cf: CloudflareClient): OutboundTransport {
  return {
    kind: "cloudflare",
    async send(envelope, raw) {
      let r;
      try {
        r = await cf.sendRawEmail(envelope.from, envelope.to, raw);
      } catch (e) {
        // 4xx other than 429 are request / account problems that a retry will not fix.
        const status = e instanceof CloudflareError ? e.status : 0;
        throw new SmtpError((e as Error).message, status >= 400 && status < 500 && status !== 429);
      }
      if (r.permanentBounces.length) throw new SmtpError(`Permanent bounce for ${r.permanentBounces.join(", ")}`, true);
    },
  };
}

/** The app-wide outbound transport (OUTBOUND_TRANSPORT), or null when it is not configured. */
export function relayTransport(deps: Deps, settings: SmtpSettings | null): OutboundTransport | null {
  if (deps.config.OUTBOUND_TRANSPORT === "cloudflare") return deps.cf.mode === "unconfigured" ? null : cloudflareTransport(deps.cf);
  return settings ? smtpTransport(deps.mail.smtp, settings) : null;
}
