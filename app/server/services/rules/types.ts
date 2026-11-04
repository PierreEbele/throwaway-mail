import { z } from "zod";
import { patternProblem } from "./regex.js";

const text = z.string().trim().min(1).max(200);
const headerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,76}$/, "Header names only contain letters, digits and dashes");
const negate = z.boolean().optional();

/** One test on a mail. `negate` turns it into "is not" / "does not". */
export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sender"), op: z.enum(["is", "contains", "ends_with"]), value: text, negate }),
  z.object({ type: z.literal("sender_domain"), value: text, negate }),
  z.object({ type: z.literal("subject_contains"), value: text, negate }),
  z.object({
    type: z.literal("recipient_matches"),
    value: z
      .string()
      .min(1)
      .max(200)
      .superRefine((v, ctx) => {
        const p = patternProblem(v);
        if (p) ctx.addIssue({ code: "custom", message: p });
      }),
    negate,
  }),
  z.object({ type: z.literal("category"), value: z.string().min(1).max(64), negate }),
  z.object({ type: z.literal("has_attachments"), negate }),
  z.object({ type: z.literal("size_over_kb"), value: z.number().int().min(0).max(1_000_000), negate }),
  z.object({ type: z.literal("header_exists"), name: headerName, negate }),
  z.object({ type: z.literal("header_equals"), name: headerName, value: z.string().trim().max(500), negate }),
  z.object({ type: z.literal("auth_failed"), value: z.enum(["any", "spf", "dkim", "dmarc"]), negate }),
  z.object({ type: z.literal("is_newsletter"), negate }),
  z.object({ type: z.literal("has_code"), negate }),
]);

/** What happens when a rule matches. */
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("block") }),
  z.object({ type: z.literal("quarantine") }),
  z.object({ type: z.literal("strip_attachments") }),
  z.object({ type: z.literal("forward_to"), destination_id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("set_category"), category_id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("mark_read") }),
  z.object({ type: z.literal("block_sender") }),
  z.object({ type: z.literal("pause_address") }),
  z.object({ type: z.literal("stop") }),
]);

export type Condition = z.infer<typeof conditionSchema>;
export type Action = z.infer<typeof actionSchema>;

export const ruleBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(conditionSchema).min(1).max(20),
  actions: z.array(actionSchema).min(1).max(10),
  address_id: z.string().max(64).nullable().optional(),
  category_id: z.string().max(64).nullable().optional(),
});

/** Everything a rule can look at, built from an incoming mail or from a stored message (rule preview). */
export interface MailFacts {
  sender: string | null;
  subject: string | null;
  /** The alias the mail was sent to. */
  recipient: string;
  categoryId: string | null;
  attachments: number;
  size: number;
  /** Lower-case header names, decoded values. */
  headers: Array<{ key: string; value: string }>;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  isBulk: boolean;
  hasCode: boolean;
}

/** The combined result of every matching rule. */
export interface RuleEffect {
  matched: Array<{ id: string; name: string }>;
  block: boolean;
  quarantine: boolean;
  stripAttachments: boolean;
  /** Destination ids that replace the address's usual forwarding targets. */
  forwardTo: string[];
  categoryId: string | null;
  markRead: boolean;
  blockSender: boolean;
  pause: boolean;
}
