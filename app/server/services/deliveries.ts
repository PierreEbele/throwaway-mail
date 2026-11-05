import { emitForwardFailed } from "./ingest/effects.js";
import PostalMime from "postal-mime";
import { and, eq } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, deliveryFailures, messageRaw, messages, type Address, type DeliveryFailure, type Message } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { conflict } from "../lib/errors.js";
import { fallbackChain, forwardDecision, userHeaderAllowlist } from "./ingest/forwarding.js";
import type { IngestResult } from "./ingest/types.js";
import { SmtpError } from "./mailbox/types.js";
import { domainOf, outboundFor } from "./replies.js";

/**
 * Delivery results of forwards (reported by the Worker, or from our own SMTP sends), the failed-deliveries log,
 * and the fallback logic shared by every SMTP sender: when a destination fails, the fallbacks are tried in order.
 */

/** One delivery attempt. `fallback_for`: the destination this attempt replaces. */
export interface DeliveryAttempt {
  to: string;
  ok: boolean;
  error?: string;
  /** The destination refused it for good (SMTP 5xx). */
  permanent?: boolean;
  fallback_for?: string;
}

/** A failure explained in plain English, and whether it is permanent. */
export function explainFailure(error: string, permanent?: boolean): { kind: "failed" | "rejected"; reason: string } {
  const e = error.toLowerCase();
  const rejected = (reason: string) => ({ kind: "rejected" as const, reason });
  const failed = (reason: string) => ({ kind: permanent ? ("rejected" as const) : ("failed" as const), reason });
  if (/not verified|unverified|destination address/.test(e))
    return rejected("The destination address is not verified (yet): click the link Cloudflare e-mailed to it.");
  if (/user unknown|no such user|does not exist|5\.1\.1|mailbox unavailable|recipient address rejected/.test(e))
    return rejected("The destination mailbox does not exist (or no longer exists).");
  if (/mailbox full|quota|5\.2\.2|4\.2\.2|over quota/.test(e)) return failed("The destination mailbox is full.");
  if (/spam|blocked|blacklist|blocklist|policy|5\.7\.\d|dmarc|reputation/.test(e))
    return rejected("The destination's mail server refused it as spam or because of its security policy.");
  if (/too large|size|5\.3\.4|552/.test(e)) return rejected("The message is too large for the destination's mail server.");
  if (/send_email binding/.test(e))
    return failed("The Worker cannot send changed or encrypted copies: its SEND_EMAIL binding is missing (see docs/installation.md).");
  if (/timed? ?out|etimedout|timeout/.test(e)) return failed("The mail server did not answer in time.");
  if (/econnrefused|enotfound|ehostunreach|connect/.test(e)) return failed("Could not connect to the outgoing mail (SMTP) server.");
  if (/auth|535|credentials|login/.test(e))
    return failed("The outgoing mail (SMTP) server refused the login: check its user and password.");
  if (/loop|too many hops/.test(e)) return rejected("A forwarding loop was detected: the destination forwards mail back here.");
  return failed(`Delivery failed: ${error.slice(0, 300)}`);
}

/**
 * Sends each job, trying the fallbacks in order when a job fails (only for jobs that may go elsewhere: encrypted
 * copies may not). Returns every attempt, fallbacks included.
 */
export async function deliverWithFallback(
  jobs: Array<{ to: string; raw: Uint8Array; fallback: boolean }>,
  fallbacks: string[],
  send: (to: string, raw: Uint8Array) => Promise<void>,
): Promise<DeliveryAttempt[]> {
  const attempts: DeliveryAttempt[] = [];
  const delivered = new Set<string>();
  const attempt = async (to: string, raw: Uint8Array, fallbackFor?: string) => {
    try {
      await send(to, raw);
      delivered.add(to);
      attempts.push({ to, ok: true, ...(fallbackFor ? { fallback_for: fallbackFor } : {}) });
      return true;
    } catch (e) {
      attempts.push({
        to,
        ok: false,
        error: (e as Error).message,
        permanent: e instanceof SmtpError ? e.permanent : undefined,
        ...(fallbackFor ? { fallback_for: fallbackFor } : {}),
      });
      return false;
    }
  };
  for (const job of jobs) {
    if (await attempt(job.to, job.raw)) continue;
    if (!job.fallback) continue;
    for (const fb of fallbacks) {
      if (delivered.has(fb) || jobs.some((j) => j.to === fb)) continue;
      if (await attempt(fb, job.raw, job.to)) break;
    }
  }
  return attempts;
}

/** The copies a forward decision asks for, as SMTP jobs (plain forwards carry the raw message unchanged). */
export function decisionJobs(decision: IngestResult, raw: Uint8Array): Array<{ to: string; raw: Uint8Array; fallback: boolean }> {
  if (decision.action !== "forward") return [];
  return [
    ...(decision.forward_to_all ?? (decision.forward_to ? [decision.forward_to] : [])).map((to) => ({ to, raw, fallback: true })),
    ...(decision.send ?? []).map((s) => ({ to: s.to, raw: Buffer.from(s.raw_base64, "base64"), fallback: !s.encrypted })),
  ];
}

/**
 * Records the outcome of a message's forwards: one log entry per failed attempt (with the fallback that took over,
 * if any), and messages.forward_to / forwarded set to where the mail really went.
 */
export function recordAttempts(deps: Deps, messageId: string, attempts: DeliveryAttempt[], transport: "cloudflare" | "smtp"): number {
  const msg = deps.db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!msg || !attempts.length) return 0;
  const now = deps.now();
  const failed = attempts.filter((a) => !a.ok);
  for (const a of failed) {
    const { kind, reason } = explainFailure(a.error ?? "unknown error", a.permanent);
    const instead = a.fallback_for ? undefined : attempts.find((x) => x.ok && x.fallback_for === a.to)?.to;
    deps.db
      .insert(deliveryFailures)
      .values({
        id: newId("dlf"),
        userId: msg.userId,
        addressId: msg.addressId,
        messageId: msg.id,
        destination: a.to,
        transport,
        kind,
        reason: a.fallback_for ? `${reason} (this was the fallback for ${a.fallback_for})` : reason,
        detail: a.error?.slice(0, 1000) ?? null,
        deliveredTo: instead ?? null,
        createdAt: now,
      })
      .run();
    if (!instead && !a.fallback_for) emitForwardFailed(deps, msg.id, a.to, reason);
  }
  const okTargets = attempts.filter((a) => a.ok).map((a) => a.to);
  // Destinations not mentioned in the report were delivered (older Workers only report failures).
  const before = (msg.forwardTo ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && !failed.some((f) => f.to === x));
  const now_ = [...new Set([...before, ...okTargets])];
  deps.db
    .update(messages)
    .set({ forwardTo: now_.length ? now_.join(", ") : null, forwarded: now_.length > 0 })
    .where(eq(messages.id, msg.id))
    .run();
  if (failed.length) deps.bus.publish(msg.userId, { type: "address.updated", address_id: msg.addressId });
  return failed.length;
}

export interface SmtpRoute {
  send: (to: string, raw: Uint8Array) => Promise<void>;
}

/** How this address's mail can be sent over SMTP from the app (mailbox SMTP or SMTP_RELAY_URL), or null. */
export function smtpRoute(deps: Deps, address: Address, alias: string): SmtpRoute | null {
  const out = outboundFor(deps, domainOf(deps, address));
  if (!out) return null;
  return { send: (to, raw) => out.transport.send({ from: out.envelopeFrom ?? alias, to: [to] }, raw) };
}

export const NO_SMTP =
  "The app has no outgoing mail server for this domain (an IMAP domain's SMTP server, or SMTP_RELAY_URL), so it cannot forward this mail itself.";

/** The raw message kept for a stored mail, or null. */
export function storedRaw(deps: Deps, messageId: string): Buffer | null {
  return deps.db.select().from(messageRaw).where(eq(messageRaw.messageId, messageId)).get()?.raw ?? null;
}

function aliasOf(deps: Deps, address: Address) {
  return `${address.localPart}@${domainOf(deps, address).name}`;
}

/**
 * Forwards a stored mail now, over SMTP, to `targets` (the same changes as at ingest: attachments removed, headers
 * filtered, PGP, reverse alias). Records the attempts. Throws 409 when it is impossible.
 */
export async function forwardStored(deps: Deps, msg: Message, address: Address, targets: string[]): Promise<DeliveryAttempt[]> {
  const raw = storedRaw(deps, msg.id);
  if (!raw) throw conflict("The original message is no longer kept (only for 3 days after it arrived), so it cannot be sent again.");
  const alias = aliasOf(deps, address);
  const route = smtpRoute(deps, address, alias);
  if (!route) throw conflict(NO_SMTP);
  const email = await PostalMime.parse(raw);
  const decision = await forwardDecision(deps, address, targets.join(", "), raw, email, alias, {
    stripAttachments: msg.stripAttachments,
    headerAllowlist: userHeaderAllowlist(deps, address.userId),
    fallbacks: fallbackChain(deps, address, targets),
  });
  const attempts = await deliverWithFallback(decisionJobs(decision, raw), decision.fallback_to ?? [], route.send);
  return attempts;
}

/** Retries one failed delivery (to the same destination). */
export async function retryFailure(deps: Deps, f: DeliveryFailure): Promise<DeliveryFailure> {
  const msg = f.messageId ? deps.db.select().from(messages).where(eq(messages.id, f.messageId)).get() : undefined;
  if (!msg) throw conflict("The message was deleted, so it cannot be sent again.");
  const address = deps.db.select().from(addresses).where(eq(addresses.id, msg.addressId)).get()!;
  const raw = storedRaw(deps, msg.id);
  if (!raw) throw conflict("The original message is no longer kept (only for 3 days after it arrived), so it cannot be sent again.");
  const alias = aliasOf(deps, address);
  const route = smtpRoute(deps, address, alias);
  if (!route) throw conflict(NO_SMTP);
  const email = await PostalMime.parse(raw);
  const decision = await forwardDecision(deps, address, f.destination, raw, email, alias, {
    stripAttachments: msg.stripAttachments,
    headerAllowlist: userHeaderAllowlist(deps, address.userId),
  });
  const now = deps.now();
  let error: { message: string; permanent?: boolean } | null = null;
  for (const job of decisionJobs(decision, raw)) {
    try {
      await route.send(job.to, job.raw);
    } catch (e) {
      error = { message: (e as Error).message, permanent: e instanceof SmtpError ? e.permanent : undefined };
    }
  }
  if (!decisionJobs(decision, raw).length) error = { message: "Nothing to send to this destination any more (removed or unverified)." };
  const set: Partial<DeliveryFailure> = { retryCount: f.retryCount + 1, lastRetryAt: now };
  if (error) Object.assign(set, { ...explainFailure(error.message, error.permanent), detail: error.message.slice(0, 1000) });
  else {
    set.resolvedAt = now;
    const targets = new Set(
      (msg.forwardTo ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );
    targets.add(f.destination);
    deps.db
      .update(messages)
      .set({ forwardTo: [...targets].join(", "), forwarded: true })
      .where(eq(messages.id, msg.id))
      .run();
  }
  deps.db.update(deliveryFailures).set(set).where(eq(deliveryFailures.id, f.id)).run();
  return deps.db.select().from(deliveryFailures).where(eq(deliveryFailures.id, f.id)).get()!;
}

/** Whether a retry can work right now (raw message kept, outgoing SMTP available). */
export function canRetry(deps: Deps, f: DeliveryFailure): boolean {
  if (f.resolvedAt || !f.messageId) return false;
  const msg = deps.db.select({ addressId: messages.addressId }).from(messages).where(eq(messages.id, f.messageId)).get();
  if (!msg || !deps.db.select({ id: messageRaw.messageId }).from(messageRaw).where(eq(messageRaw.messageId, f.messageId)).get())
    return false;
  const address = deps.db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, msg.addressId)))
    .get();
  return !!address && !!outboundFor(deps, domainOf(deps, address));
}
