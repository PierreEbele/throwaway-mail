import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter, Ctx } from "../lib/http.js";
import type { Deps } from "../context.js";
import { addresses, categories, destinations, messages, rules, type Rule } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { clientIp } from "../lib/http.js";
import { factsFromMessage, ruleActions, ruleConditions, ruleMatches } from "../services/rules/engine.js";
import { conditionSchema, ruleBodySchema, type Action, type Condition } from "../services/rules/types.js";

/** How many recent messages the rule preview runs on. */
export const PREVIEW_SIZE = 20;

export function ruleOut(r: Rule) {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    position: r.position,
    match: r.match,
    conditions: ruleConditions(r),
    actions: ruleActions(r),
    address_id: r.addressId,
    category_id: r.categoryId,
    match_count: r.matchCount,
    last_matched_at: r.lastMatchedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Every id a rule refers to must belong to the user (addresses, categories, destinations). */
function checkRefs(
  deps: Deps,
  userId: string,
  scope: { address_id?: string | null; category_id?: string | null },
  conditions: Condition[],
  actions: Action[],
) {
  const own = (table: typeof addresses | typeof categories | typeof destinations, id: string) =>
    !!deps.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.userId, userId)))
      .get();
  if (scope.address_id && !own(addresses, scope.address_id)) throw badRequest("Unknown address");
  if (scope.category_id && !own(categories, scope.category_id)) throw badRequest("Unknown category");
  if (scope.address_id && scope.category_id) throw badRequest("A rule applies to one address or one category, not both");
  for (const c of conditions) if (c.type === "category" && !own(categories, c.value)) throw badRequest("Unknown category in a condition");
  for (const a of actions) {
    if (a.type === "forward_to" && !own(destinations, a.destination_id)) throw badRequest("Unknown destination in an action");
    if (a.type === "set_category" && !own(categories, a.category_id)) throw badRequest("Unknown category in an action");
  }
  if (actions.some((a) => a.type === "block") && actions.some((a) => a.type === "quarantine"))
    throw badRequest("A rule cannot both block and quarantine mail");
}

export function registerRules(r: ApiRouter) {
  const owned = (c: Ctx) => {
    const row = c
      .get("deps")
      .db.select()
      .from(rules)
      .where(and(eq(rules.id, c.req.param("id")!), eq(rules.userId, c.get("user")!.id)))
      .get();
    if (!row) throw notFound("Rule");
    return row;
  };

  r.add({ method: "get", path: "/v1/rules", summary: "List own mail rules, in evaluation order", tags: ["rules"], auth: "user" }, (c) => {
    const rows = c
      .get("deps")
      .db.select()
      .from(rules)
      .where(eq(rules.userId, c.get("user")!.id))
      .orderBy(asc(rules.position), asc(rules.createdAt))
      .all();
    return c.json({ rules: rows.map(ruleOut) });
  });

  r.add(
    {
      method: "post",
      path: "/v1/rules",
      summary: "Create a mail rule (added last)",
      description:
        "Conditions are combined with match = all (AND) or any (OR). Actions: block, quarantine, strip_attachments, forward_to, " +
        "set_category, mark_read, block_sender, pause_address, stop. See docs/user-guide.md (Rules).",
      tags: ["rules"],
      auth: "user",
      body: ruleBodySchema,
      responses: { 201: "Created" },
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      checkRefs(d, user.id, body, body.conditions, body.actions);
      const last = d.db
        .select({ p: max(rules.position) })
        .from(rules)
        .where(eq(rules.userId, user.id))
        .get();
      const now = d.now();
      const row = {
        id: newId("rul"),
        userId: user.id,
        addressId: body.address_id ?? null,
        categoryId: body.category_id ?? null,
        name: body.name,
        enabled: body.enabled ?? true,
        position: (last?.p ?? -1) + 1,
        match: body.match,
        conditionsJson: JSON.stringify(body.conditions),
        actionsJson: JSON.stringify(body.actions),
        createdAt: now,
        updatedAt: now,
      };
      d.db.insert(rules).values(row).run();
      audit(d, user.id, "rule.created", row.id, { name: row.name }, clientIp(c));
      return c.json({ rule: ruleOut(d.db.select().from(rules).where(eq(rules.id, row.id)).get()!) }, 201);
    },
  );

  r.add(
    {
      method: "patch",
      path: "/v1/rules/:id",
      summary: "Edit a rule, or enable / disable it",
      tags: ["rules"],
      auth: "user",
      body: ruleBodySchema.partial(),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const row = owned(c);
      const conditions = body.conditions ?? ruleConditions(row);
      const actions = body.actions ?? ruleActions(row);
      const scope = {
        address_id: body.address_id !== undefined ? body.address_id : row.addressId,
        category_id: body.category_id !== undefined ? body.category_id : row.categoryId,
      };
      checkRefs(d, user.id, scope, conditions, actions);
      d.db
        .update(rules)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.match !== undefined ? { match: body.match } : {}),
          conditionsJson: JSON.stringify(conditions),
          actionsJson: JSON.stringify(actions),
          addressId: scope.address_id ?? null,
          categoryId: scope.category_id ?? null,
          updatedAt: d.now(),
        })
        .where(eq(rules.id, row.id))
        .run();
      return c.json({ rule: ruleOut(d.db.select().from(rules).where(eq(rules.id, row.id)).get()!) });
    },
  );

  r.add({ method: "delete", path: "/v1/rules/:id", summary: "Delete a rule", tags: ["rules"], auth: "user" }, (c) => {
    const d = c.get("deps");
    const row = owned(c);
    d.db.delete(rules).where(eq(rules.id, row.id)).run();
    audit(d, row.userId, "rule.deleted", row.id, { name: row.name }, clientIp(c));
    return c.json({ ok: true });
  });

  r.add(
    {
      method: "post",
      path: "/v1/rules/reorder",
      summary: "Set the evaluation order: every rule id, first rule first",
      tags: ["rules"],
      auth: "user",
      body: z.object({ ids: z.array(z.string().max(64)).max(500) }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const mine = d.db.select({ id: rules.id }).from(rules).where(eq(rules.userId, user.id)).all();
      if (mine.length !== body.ids.length || !mine.every((x) => body.ids.includes(x.id)))
        throw badRequest("ids must list every rule exactly once");
      d.db.transaction((tx) => {
        body.ids.forEach((id, i) =>
          tx
            .update(rules)
            .set({ position: i })
            .where(and(eq(rules.id, id), eq(rules.userId, user.id)))
            .run(),
        );
      });
      const rows = d.db.select().from(rules).where(eq(rules.userId, user.id)).orderBy(asc(rules.position)).all();
      return c.json({ rules: rows.map(ruleOut) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/rules/test",
      summary: `Preview: which of the last ${PREVIEW_SIZE} messages these conditions would match`,
      description: "Nothing is changed. With address_id or category_id, only that address's / category's mail is used.",
      tags: ["rules"],
      auth: "user",
      body: z.object({
        match: z.enum(["all", "any"]).default("all"),
        conditions: z.array(conditionSchema).min(1).max(20),
        address_id: z.string().max(64).nullable().optional(),
        category_id: z.string().max(64).nullable().optional(),
      }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      checkRefs(d, user.id, body, body.conditions, []);
      const addrs = d.db
        .select({ id: addresses.id, categoryId: addresses.categoryId })
        .from(addresses)
        .where(eq(addresses.userId, user.id))
        .all();
      const cat = new Map(addrs.map((a) => [a.id, a.categoryId]));
      const scoped = addrs
        .filter((a) => (!body.address_id || a.id === body.address_id) && (!body.category_id || a.categoryId === body.category_id))
        .map((a) => a.id);
      const rows = scoped.length
        ? d.db
            .select()
            .from(messages)
            .where(and(eq(messages.userId, user.id), inArray(messages.addressId, scoped)))
            .orderBy(desc(messages.receivedAt))
            .limit(PREVIEW_SIZE)
            .all()
        : [];
      const results = rows.map((m) => ({
        message_id: m.id,
        address_id: m.addressId,
        from: m.fromAddr,
        subject: m.subject,
        received_at: m.receivedAt,
        matched: ruleMatches(body.match, body.conditions, factsFromMessage(d, m, cat.get(m.addressId) ?? null)),
      }));
      return c.json({ tested: results.length, matched: results.filter((x) => x.matched).length, results });
    },
  );
}
