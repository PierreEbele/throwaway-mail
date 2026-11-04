import { eq, sql } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { addresses, leakEvents, messages, type Address } from "../../db/schema.js";
import { newId } from "../../lib/crypto.js";
import { baseDomain, senderDomain } from "../../lib/senders.js";
import { notify } from "../notify.js";

type Db = Pick<Deps["db"], "insert" | "update">;

/** Flags the address as leaked and keeps the event in the history. */
export function recordLeak(db: Db, address: Address, sender: string, at: number) {
  db.update(addresses).set({ leakSender: sender, leakAt: at }).where(eq(addresses.id, address.id)).run();
  db.insert(leakEvents)
    .values({
      id: newId("lek"),
      userId: address.userId,
      addressId: address.id,
      sender,
      senderDomain: baseDomain(senderDomain(sender)!),
      at,
    })
    .run();
}

export const addressLink = (deps: Deps, address: Address) => `${deps.config.APP_URL.replace(/\/$/, "")}/addresses/${address.id}`;

export interface StoredMail {
  address: Address;
  /** The address as written by the sender (normalised). */
  rcpt: string;
  messageId: string;
  from: string | null;
  subject: string | null;
  code: string | null;
  leak: boolean;
  at: number;
}

/**
 * After a mail is stored: push notifications and self-destruction (pause after N mails / after the first code).
 * Returns without waiting for notification endpoints.
 */
export function afterStore(deps: Deps, m: StoredMail): void {
  const { address, rcpt } = m;
  const link = addressLink(deps, address);
  const site = address.siteName;
  const data = { address_id: address.id, address: rcpt, site, message_id: m.messageId, from: m.from, subject: m.subject };
  const pushes: Promise<unknown>[] = [
    notify(deps, address.userId, {
      type: "message.received",
      title: `New mail for ${site}`,
      body: `${m.from ?? "?"}: ${m.subject ?? "(no subject)"}`,
      url: link,
      data,
    }),
  ];
  if (m.code) {
    pushes.push(
      notify(deps, address.userId, {
        type: "code.received",
        title: `Code ${m.code}`,
        body: `${site} · ${m.subject ?? ""}`.trim(),
        url: link,
        data: { ...data, code: m.code },
      }),
    );
  }
  if (m.leak) {
    pushes.push(
      notify(deps, address.userId, {
        type: "leak.detected",
        title: `Possible leak: ${site}`,
        body: `${rcpt} received mail from ${m.from}, which is not ${site}.`,
        url: link,
        data,
      }),
    );
  }
  const burn = burnReason(deps, address, !!m.code);
  if (burn) {
    deps.db
      .update(addresses)
      .set({ status: "paused", burnReason: burn, burnedAt: m.at, updatedAt: m.at })
      .where(eq(addresses.id, address.id))
      .run();
    deps.bus.publish(address.userId, { type: "address.updated", address_id: address.id });
    pushes.push(
      notify(deps, address.userId, {
        type: "address.burned",
        title: `${site}: address burned`,
        body:
          burn === "after_code"
            ? `${rcpt} received its code and now rejects mail.`
            : `${rcpt} reached ${address.maxMessages} mail(s) and now rejects mail.`,
        url: link,
        data: { ...data, reason: burn },
      }),
    );
  }
  // Never delay the Worker's answer on slow notification endpoints.
  void Promise.all(pushes).catch(() => {});
}

function burnReason(deps: Deps, address: Address, hasCode: boolean): "after_code" | "max_messages" | null {
  if (address.burnAfterCode && hasCode) return "after_code";
  if (!address.maxMessages) return null;
  const count = deps.db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.addressId, address.id))
    .get()!.n;
  return count >= address.maxMessages ? "max_messages" : null;
}

/** A site-locked address refusing a mail from another sender: keep the evidence and warn. */
export function rejectLockedLeak(deps: Deps, address: Address, rcpt: string, sender: string) {
  recordLeak(deps.db, address, sender, deps.now());
  deps.bus.publish(address.userId, { type: "address.updated", address_id: address.id });
  void notify(deps, address.userId, {
    type: "leak.detected",
    title: `Blocked leak: ${address.siteName}`,
    body: `${rcpt} is locked to ${address.siteName}; mail from ${sender} was rejected.`,
    url: addressLink(deps, address),
    data: { address_id: address.id, address: rcpt, site: address.siteName, from: sender, rejected: true },
  }).catch(() => {});
}

/** A mail refused for an existing address (blocked sender, promotions, site lock, paused or expired address). */
export function emitBlocked(deps: Deps, address: Address, rcpt: string, from: string | null, reason: string) {
  void notify(deps, address.userId, {
    type: "message.blocked",
    title: `Mail blocked: ${address.siteName}`,
    body: `${rcpt} refused mail from ${from ?? "?"} (${reason}).`,
    url: addressLink(deps, address),
    data: { address_id: address.id, address: rcpt, site: address.siteName, from, reason },
  }).catch(() => {});
}

/** A forward refused for good by the SMTP server of an IMAP domain. */
export function emitForwardFailed(deps: Deps, messageId: string | undefined, to: string, error: string) {
  if (!messageId) return;
  const row = deps.db
    .select({ a: addresses, rcpt: messages.envelopeTo })
    .from(messages)
    .innerJoin(addresses, eq(addresses.id, messages.addressId))
    .where(eq(messages.id, messageId))
    .get();
  if (!row) return;
  void notify(deps, row.a.userId, {
    type: "forward.failed",
    title: `Forward failed: ${row.a.siteName}`,
    body: `Mail for ${row.rcpt} could not be forwarded to ${to}: ${error}`,
    url: addressLink(deps, row.a),
    data: { address_id: row.a.id, address: row.rcpt, site: row.a.siteName, message_id: messageId, to, error },
  }).catch(() => {});
}
