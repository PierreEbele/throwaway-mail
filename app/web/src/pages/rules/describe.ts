import type { RuleAction, RuleCondition } from "../../types";

/** Plain-English labels for the rule builder (kept readable for people who never wrote a filter). */
export const CONDITION_LABELS: Record<RuleCondition["type"], string> = {
  sender: "Sender address",
  sender_domain: "Sender's domain",
  subject_contains: "Subject contains",
  recipient_matches: "Alias matches pattern (advanced)",
  category: "Address is in category",
  has_attachments: "Has attachments",
  size_over_kb: "Is larger than (KB)",
  header_exists: "Has the header",
  header_equals: "Header equals",
  auth_failed: "Failed sender checks",
  is_newsletter: "Is a newsletter or bulk mail",
  has_code: "Contains a verification code",
};

export const ACTION_LABELS: Record<RuleAction["type"], string> = {
  block: "Block it (refuse the mail)",
  quarantine: "Quarantine it (keep, do not forward)",
  strip_attachments: "Remove attachments before forwarding",
  forward_to: "Forward to a specific mailbox",
  set_category: "Move the address to a category",
  mark_read: "Mark as read",
  block_sender: "Block this sender's domain from now on",
  pause_address: "Pause the address",
  stop: "Stop: ignore the rules below",
};

export const AUTH_LABELS = { any: "any check (SPF, DKIM or DMARC)", spf: "SPF", dkim: "DKIM", dmarc: "DMARC" } as const;

export function defaultCondition(type: RuleCondition["type"]): RuleCondition {
  switch (type) {
    case "sender":
      return { type, op: "is", value: "" };
    case "sender_domain":
    case "subject_contains":
    case "recipient_matches":
    case "category":
      return { type, value: "" };
    case "size_over_kb":
      return { type, value: 1024 };
    case "header_exists":
      return { type, name: "" };
    case "header_equals":
      return { type, name: "", value: "" };
    case "auth_failed":
      return { type, value: "any" };
    default:
      return { type };
  }
}

export function defaultAction(type: RuleAction["type"]): RuleAction {
  if (type === "forward_to") return { type, destination_id: "" };
  if (type === "set_category") return { type, category_id: "" };
  return { type };
}

/** One condition as a short sentence. */
export function describeCondition(c: RuleCondition, names: { category: (id: string) => string }): string {
  const not = c.negate ? "not " : "";
  switch (c.type) {
    case "sender":
      return `sender ${c.negate ? "does not " : ""}${c.op === "is" ? (c.negate ? "equal" : "is") : c.op === "contains" ? (c.negate ? "contain" : "contains") : c.negate ? "end with" : "ends with"} "${c.value}"`;
    case "sender_domain":
      return `sender's domain is ${not}${c.value}`;
    case "subject_contains":
      return `subject ${c.negate ? "does not contain" : "contains"} "${c.value}"`;
    case "recipient_matches":
      return `alias ${c.negate ? "does not match" : "matches"} /${c.value}/`;
    case "category":
      return `address is ${not}in ${names.category(c.value)}`;
    case "has_attachments":
      return c.negate ? "no attachments" : "has attachments";
    case "size_over_kb":
      return `${c.negate ? "not " : ""}larger than ${c.value} KB`;
    case "header_exists":
      return `${c.negate ? "no" : "has a"} ${c.name} header`;
    case "header_equals":
      return `${c.name} is ${not}"${c.value}"`;
    case "auth_failed":
      return `${c.negate ? "passed" : "failed"} ${AUTH_LABELS[c.value]}`;
    case "is_newsletter":
      return c.negate ? "not a newsletter" : "is a newsletter";
    case "has_code":
      return c.negate ? "no verification code" : "has a verification code";
  }
}

export function describeAction(a: RuleAction, names: { category: (id: string) => string; destination: (id: string) => string }) {
  if (a.type === "forward_to") return `forward to ${names.destination(a.destination_id)}`;
  if (a.type === "set_category") return `move the address to ${names.category(a.category_id)}`;
  return ACTION_LABELS[a.type].replace(/ \(.*\)$/, "").replace(/^./, (x) => x.toLowerCase());
}
