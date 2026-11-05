import type { RuleAction, RuleCondition } from "../../types";
import { msg } from "../../i18n";
import { formatNumber } from "../../util";

/** Labels for the rule builder (kept readable for people who never wrote a filter), in the current language. */
export const conditionLabels = (): Record<RuleCondition["type"], string> => msg().rules.conditions;
export const actionLabels = (): Record<RuleAction["type"], string> => msg().rules.actions;
export const authLabels = (): Record<"any" | "spf" | "dkim" | "dmarc", string> => msg().rules.auth;

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
  const t = msg().rules.describe;
  const neg = !!c.negate;
  switch (c.type) {
    case "sender":
      return t.sender(neg, c.op, c.value);
    case "sender_domain":
      return t.senderDomain(neg, c.value);
    case "subject_contains":
      return t.subject(neg, c.value);
    case "recipient_matches":
      return t.alias(neg, c.value);
    case "category":
      return t.category(neg, names.category(c.value));
    case "has_attachments":
      return t.attachments(neg);
    case "size_over_kb":
      return t.size(neg, formatNumber(c.value));
    case "header_exists":
      return t.headerExists(neg, c.name);
    case "header_equals":
      return t.headerEquals(neg, c.name, c.value);
    case "auth_failed":
      return t.auth(neg, authLabels()[c.value]);
    case "is_newsletter":
      return t.newsletter(neg);
    case "has_code":
      return t.code(neg);
  }
}

export function describeAction(a: RuleAction, names: { category: (id: string) => string; destination: (id: string) => string }) {
  const t = msg().rules;
  if (a.type === "forward_to") return t.describe.forwardTo(names.destination(a.destination_id));
  if (a.type === "set_category") return t.describe.moveTo(names.category(a.category_id));
  return (t.actionsShort as Record<RuleAction["type"], string>)[a.type];
}
