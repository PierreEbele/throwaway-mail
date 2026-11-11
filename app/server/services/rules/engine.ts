import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../../context.js";
import { addresses, categories, extractedItems, rules, type Address, type Message, type Rule } from "../../db/schema.js";
import { listed, parseList } from "../../lib/senders.js";
import { safeTest, usablePattern } from "./regex.js";
import type { Action, Condition, MailFacts, RuleEffect } from "./types.js";

const FAILED = new Set(["fail", "softfail", "permerror"]);

function senderDomainOf(sender: string | null): string | null {
  const at = sender?.lastIndexOf("@") ?? -1;
  return at >= 0 ? sender!.slice(at + 1).toLowerCase() : null;
}

function test(c: Condition, f: MailFacts): boolean {
  const sender = (f.sender ?? "").toLowerCase();
  switch (c.type) {
    case "sender": {
      const v = c.value.toLowerCase();
      return c.op === "is" ? sender === v : c.op === "contains" ? sender.includes(v) : sender.endsWith(v);
    }
    case "sender_domain": {
      const d = senderDomainOf(f.sender);
      const v = c.value.toLowerCase().replace(/^@/, "");
      return !!d && (d === v || d.endsWith("." + v));
    }
    case "subject_contains":
      return (f.subject ?? "").toLowerCase().includes(c.value.toLowerCase());
    case "recipient_matches":
      return safeTest(c.value, f.recipient);
    case "category":
      return f.categoryId === c.value;
    case "has_attachments":
      return f.attachments > 0;
    case "size_over_kb":
      return f.size > c.value * 1024;
    case "header_exists":
      return f.headers.some((h) => h.key === c.name.toLowerCase());
    case "header_equals": {
      const v = c.value.toLowerCase();
      return f.headers.some((h) => h.key === c.name.toLowerCase() && h.value.trim().toLowerCase() === v);
    }
    case "auth_failed": {
      const mechs = c.value === "any" ? (["spf", "dkim", "dmarc"] as const) : [c.value];
      return mechs.some((m) => FAILED.has(f.auth[m] ?? ""));
    }
    case "is_newsletter":
      return f.isBulk;
    case "has_code":
      return f.hasCode;
  }
}

/** Whether a rule's conditions match these facts. */
export function ruleMatches(match: "all" | "any", conditions: Condition[], f: MailFacts): boolean {
  // A pattern refused by the current checks disables its whole rule, negated or not, rather than being run.
  if (conditions.some((c) => c.type === "recipient_matches" && !usablePattern(c.value))) return false;
  const results = conditions.map((c) => test(c, f) !== !!c.negate);
  return match === "all" ? results.every(Boolean) : results.some(Boolean);
}

export const ruleConditions = (r: Rule) => JSON.parse(r.conditionsJson) as Condition[];
export const ruleActions = (r: Rule) => JSON.parse(r.actionsJson) as Action[];

/** Enabled rules that apply to this address (all-address rules, its own, its category's), in order. */
export function rulesFor(deps: Deps, address: Address): Rule[] {
  return deps.db
    .select()
    .from(rules)
    .where(and(eq(rules.userId, address.userId), eq(rules.enabled, true)))
    .orderBy(asc(rules.position), asc(rules.createdAt))
    .all()
    .filter((r) => (!r.addressId || r.addressId === address.id) && (!r.categoryId || r.categoryId === address.categoryId));
}

export function emptyEffect(): RuleEffect {
  return {
    matched: [],
    block: false,
    quarantine: false,
    stripAttachments: false,
    forwardTo: [],
    categoryId: null,
    markRead: false,
    blockSender: false,
    pause: false,
  };
}

/** Runs the rules in order and merges the actions of every match, until a "stop" action. */
export function evaluate(list: Rule[], f: MailFacts): RuleEffect {
  const e = emptyEffect();
  for (const r of list) {
    if (!ruleMatches(r.match, ruleConditions(r), f)) continue;
    e.matched.push({ id: r.id, name: r.name });
    let stop = false;
    for (const a of ruleActions(r)) {
      if (a.type === "block") e.block = true;
      else if (a.type === "quarantine") e.quarantine = true;
      else if (a.type === "strip_attachments") e.stripAttachments = true;
      else if (a.type === "forward_to") e.forwardTo.push(a.destination_id);
      else if (a.type === "set_category") e.categoryId = a.category_id;
      else if (a.type === "mark_read") e.markRead = true;
      else if (a.type === "block_sender") e.blockSender = true;
      else if (a.type === "pause_address") e.pause = true;
      else if (a.type === "stop") stop = true;
    }
    if (stop) break;
  }
  return e;
}

/** Counts the matches (shown on the Rules page). */
export function recordMatches(deps: Deps, e: RuleEffect) {
  if (!e.matched.length) return;
  deps.db
    .update(rules)
    .set({ matchCount: sql`${rules.matchCount} + 1`, lastMatchedAt: deps.now() })
    .where(
      inArray(
        rules.id,
        e.matched.map((m) => m.id),
      ),
    )
    .run();
}

/** Address-level effects of the matching rules: move to a category, block the sender, pause the address. */
export function applyAddressEffects(deps: Deps, address: Address, e: RuleEffect, sender: string | null) {
  const set: Partial<Address> = {};
  if (e.categoryId && e.categoryId !== address.categoryId) {
    const ok = deps.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, e.categoryId), eq(categories.userId, address.userId)))
      .get();
    if (ok) set.categoryId = e.categoryId;
  }
  const domain = senderDomainOf(sender);
  if (e.blockSender && domain) {
    const list = parseList(address.blockedSendersJson);
    if (!listed(list, domain)) set.blockedSendersJson = JSON.stringify([...list, domain]);
  }
  if (e.pause && address.status === "active") Object.assign(set, { status: "paused", burnReason: "rule", burnedAt: deps.now() });
  if (!Object.keys(set).length) return;
  deps.db
    .update(addresses)
    .set({ ...set, updatedAt: deps.now() })
    .where(eq(addresses.id, address.id))
    .run();
  deps.bus.publish(address.userId, { type: "address.updated", address_id: address.id });
}

/** Facts of a stored message, for the "test against recent mail" preview. */
export function factsFromMessage(deps: Deps, m: Message, categoryId: string | null): MailFacts {
  const hasCode = !!deps.db
    .select({ id: extractedItems.id })
    .from(extractedItems)
    .where(and(eq(extractedItems.messageId, m.id), eq(extractedItems.kind, "code")))
    .get();
  return {
    sender: m.fromAddr,
    subject: m.subject,
    recipient: m.envelopeTo,
    categoryId,
    attachments: m.attachmentsJson ? (JSON.parse(m.attachmentsJson) as Array<{ inline?: boolean }>).filter((a) => !a.inline).length : 0,
    size: m.rawSize,
    headers: m.headersJson ? (JSON.parse(m.headersJson) as MailFacts["headers"]) : [],
    auth: { spf: m.spf, dkim: m.dkim, dmarc: m.dmarc },
    isBulk: m.isBulk,
    hasCode,
  };
}
