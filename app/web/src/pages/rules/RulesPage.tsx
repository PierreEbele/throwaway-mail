import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../../api";
import type { Address, Rule, RuleAction, RuleCondition, RuleTestResult } from "../../types";
import { EmptyState, ErrorText, PageHeader, Spinner, Toggle, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { useDestinations } from "../Addresses";
import { useCategories } from "../mailbox/shared";
import {
  ACTION_LABELS,
  AUTH_LABELS,
  CONDITION_LABELS,
  defaultAction,
  defaultCondition,
  describeAction,
  describeCondition,
} from "./describe";

type Draft = Omit<Rule, "id" | "position" | "match_count" | "last_matched_at" | "created_at" | "updated_at"> & { id?: string };

const EMPTY: Draft = {
  name: "",
  enabled: true,
  match: "all",
  conditions: [{ type: "sender_domain", value: "" }],
  actions: [{ type: "quarantine" }],
  address_id: null,
  category_id: null,
};

function useAddresses() {
  return useQuery({
    queryKey: ["addresses", "all-for-rules"],
    queryFn: () => get<{ addresses: Address[] }>("/v1/addresses?limit=1000").then((r) => r.addresses),
  });
}

function useNames() {
  const cats = useCategories();
  const dests = useDestinations();
  const addrs = useAddresses();
  return useMemo(
    () => ({
      category: (id: string) => cats.data?.find((c) => c.id === id)?.name ?? "a deleted category",
      destination: (id: string) => dests.data?.find((d) => d.id === id)?.email ?? "a deleted mailbox",
      address: (id: string) => addrs.data?.find((a) => a.id === id)?.email ?? "a deleted address",
    }),
    [cats.data, dests.data, addrs.data],
  );
}

export function RulesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const names = useNames();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => get<{ rules: Rule[] }>("/v1/rules").then((r) => r.rules) });
  const [editing, setEditing] = useState<Draft | null>(null);
  const inv = () => invalidate(qc, ["rules"]);
  const onError = (e: Error) => toast(e.message, "error");
  const toggle = useMutation({ mutationFn: (r: Rule) => patch(`/v1/rules/${r.id}`, { enabled: !r.enabled }), onSuccess: inv, onError });
  const remove = useMutation({ mutationFn: (r: Rule) => del(`/v1/rules/${r.id}`), onSuccess: inv, onError });
  const reorder = useMutation({ mutationFn: (ids: string[]) => post("/v1/rules/reorder", { ids }), onSuccess: inv, onError });
  const move = (i: number, dir: -1 | 1) => {
    const ids = rules.data!.map((r) => r.id);
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <>
      <PageHeader
        title="Rules"
        subtitle="Rules run from top to bottom on every mail that arrives. Each rule checks a few things about the mail and, when they match, does something with it."
        actions={
          !editing && (
            <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
              New rule
            </button>
          )
        }
      />
      {editing && <RuleEditor key={editing.id ?? "new"} draft={editing} onDone={() => setEditing(null)} />}
      {rules.isLoading && <Spinner />}
      <ErrorText error={rules.error} />
      {rules.data?.length === 0 && !editing && (
        <EmptyState title="No rules yet">
          For example: quarantine mail that fails DMARC, or remove attachments from newsletters before they are forwarded.
        </EmptyState>
      )}
      {!!rules.data?.length && (
        <ol className="card divide-y divide-zinc-200 dark:divide-zinc-800" aria-label="Rules, in the order they run">
          {rules.data.map((r, i) => (
            <li key={r.id} className={`flex flex-wrap items-start gap-3 px-4 py-3 ${r.enabled ? "" : "opacity-60"}`}>
              <div className="flex flex-col gap-0.5 pt-0.5">
                <button
                  className="btn-ghost px-1 py-0 text-xs"
                  disabled={i === 0 || reorder.isPending}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${r.name} up`}
                >
                  ▲
                </button>
                <button
                  className="btn-ghost px-1 py-0 text-xs"
                  disabled={i === rules.data!.length - 1 || reorder.isPending}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${r.name} down`}
                >
                  ▼
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {i + 1}. {r.name}
                </p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {r.address_id
                    ? `For ${names.address(r.address_id)}: when `
                    : r.category_id
                      ? `For addresses in ${names.category(r.category_id)}: when `
                      : "When "}
                  {r.conditions.length > 1 ? (r.match === "all" ? "all of: " : "any of: ") : ""}
                  {r.conditions.map((c) => describeCondition(c, names)).join(r.match === "all" ? " and " : " or ")}
                  {" → "}
                  {r.actions.map((a) => describeAction(a, names)).join(", ")}
                </p>
                <p className="text-xs text-zinc-500">
                  {r.match_count ? `Matched ${r.match_count} mail(s), last ${timeAgo(r.last_matched_at)}` : "Has not matched any mail yet"}
                </p>
              </div>
              <Toggle checked={r.enabled} onChange={() => toggle.mutate(r)} label={`Enable ${r.name}`} />
              <button className="btn-secondary" onClick={() => setEditing({ ...r })}>
                Edit
              </button>
              <button className="btn-ghost text-red-600" onClick={() => confirmAction(`Delete the rule "${r.name}"?`) && remove.mutate(r)}>
                Delete
              </button>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function RuleEditor({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useCategories();
  const dests = useDestinations();
  const addrs = useAddresses();
  const [d, setD] = useState<Draft>(draft);
  const [preview, setPreview] = useState<RuleTestResult | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const setCond = (i: number, c: RuleCondition) => set({ conditions: d.conditions.map((x, j) => (j === i ? c : x)) });
  const setAct = (i: number, a: RuleAction) => set({ actions: d.actions.map((x, j) => (j === i ? a : x)) });
  const body = () => ({
    name: d.name,
    enabled: d.enabled,
    match: d.match,
    conditions: d.conditions,
    actions: d.actions,
    address_id: d.address_id,
    category_id: d.category_id,
  });
  const save = useMutation({
    mutationFn: () => (d.id ? patch(`/v1/rules/${d.id}`, body()) : post("/v1/rules", body())),
    onSuccess: () => {
      invalidate(qc, ["rules"]);
      toast(d.id ? "Rule saved" : "Rule created", "success");
      onDone();
    },
  });
  const test = useMutation({
    mutationFn: () =>
      post<RuleTestResult>("/v1/rules/test", {
        match: d.match,
        conditions: d.conditions,
        address_id: d.address_id,
        category_id: d.category_id,
      }),
    onSuccess: setPreview,
  });
  const scope = d.address_id ? `a:${d.address_id}` : d.category_id ? `c:${d.category_id}` : "";

  return (
    <form
      className="card mb-6 space-y-5 p-5"
      aria-label={d.id ? "Edit rule" : "New rule"}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="rule-name" className="label">
            Name
          </label>
          <input
            id="rule-name"
            className="input"
            required
            maxLength={100}
            placeholder="Quarantine forged mail"
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="rule-scope" className="label">
            Applies to
          </label>
          <select
            id="rule-scope"
            className="input"
            value={scope}
            onChange={(e) => {
              const v = e.target.value;
              set({ address_id: v.startsWith("a:") ? v.slice(2) : null, category_id: v.startsWith("c:") ? v.slice(2) : null });
            }}
          >
            <option value="">All my addresses</option>
            {!!cats.data?.length && (
              <optgroup label="Addresses in a category">
                {cats.data.map((c) => (
                  <option key={c.id} value={`c:${c.id}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
            {!!addrs.data?.length && (
              <optgroup label="One address">
                {addrs.data.map((a) => (
                  <option key={a.id} value={`a:${a.id}`}>
                    {a.site_name} ({a.email})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">
          When{" "}
          <select
            aria-label="How conditions combine"
            className="input inline-block w-auto py-0.5"
            value={d.match}
            onChange={(e) => set({ match: e.target.value as "all" | "any" })}
          >
            <option value="all">all of these are true</option>
            <option value="any">any of these is true</option>
          </select>
        </legend>
        {d.conditions.map((c, i) => (
          <ConditionRow
            key={i}
            c={c}
            onChange={(x) => setCond(i, x)}
            onRemove={d.conditions.length > 1 ? () => set({ conditions: d.conditions.filter((_, j) => j !== i) }) : undefined}
            categories={cats.data ?? []}
          />
        ))}
        <button
          type="button"
          className="btn-ghost text-sm"
          disabled={d.conditions.length >= 20}
          onClick={() => set({ conditions: [...d.conditions, defaultCondition("subject_contains")] })}
        >
          + Add a condition
        </button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Then</legend>
        {d.actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Action"
              className="input w-auto"
              value={a.type}
              onChange={(e) => setAct(i, defaultAction(e.target.value as RuleAction["type"]))}
            >
              {Object.entries(ACTION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {a.type === "forward_to" && (
              <select
                aria-label="Mailbox"
                className="input w-auto"
                required
                value={a.destination_id}
                onChange={(e) => setAct(i, { type: "forward_to", destination_id: e.target.value })}
              >
                <option value="">Choose a mailbox…</option>
                {dests.data?.map((x) => (
                  <option key={x.id} value={x.id} disabled={!x.verified}>
                    {x.email}
                    {x.verified ? "" : " (not verified)"}
                  </option>
                ))}
              </select>
            )}
            {a.type === "set_category" && (
              <select
                aria-label="Category"
                className="input w-auto"
                required
                value={a.category_id}
                onChange={(e) => setAct(i, { type: "set_category", category_id: e.target.value })}
              >
                <option value="">Choose a category…</option>
                {cats.data?.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            {d.actions.length > 1 && (
              <button
                type="button"
                className="btn-ghost text-sm"
                aria-label="Remove this action"
                onClick={() => set({ actions: d.actions.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost text-sm"
          disabled={d.actions.length >= 10}
          onClick={() => set({ actions: [...d.actions, defaultAction("mark_read")] })}
        >
          + Add an action
        </button>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={save.isPending}>
          {d.id ? "Save rule" : "Create rule"}
        </button>
        <button type="button" className="btn-secondary" disabled={test.isPending} onClick={() => test.mutate()}>
          Test against the last 20 messages
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorText error={save.error ?? test.error} />
      {preview && (
        <div aria-live="polite" className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
          <p className="mb-2 font-medium">
            {preview.tested === 0
              ? "No mail to test against yet."
              : `This rule would match ${preview.matched} of the last ${preview.tested} message(s).`}
          </p>
          <ul className="space-y-1">
            {preview.results.map((r) => (
              <li key={r.message_id} className={r.matched ? "" : "text-zinc-500"}>
                <span aria-label={r.matched ? "matches" : "does not match"}>{r.matched ? "✓" : "·"}</span> {r.subject ?? "(no subject)"}{" "}
                <span className="text-xs text-zinc-500">
                  from {r.from ?? "?"}, {timeAgo(r.received_at)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-500">The preview only checks the conditions; nothing is changed. It is not saved yet.</p>
        </div>
      )}
    </form>
  );
}

function ConditionRow({
  c,
  onChange,
  onRemove,
  categories,
}: {
  c: RuleCondition;
  onChange: (c: RuleCondition) => void;
  onRemove?: () => void;
  categories: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Condition"
        className="input w-auto"
        value={c.type}
        onChange={(e) => onChange({ ...defaultCondition(e.target.value as RuleCondition["type"]), negate: c.negate })}
      >
        {Object.entries(CONDITION_LABELS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <select
        aria-label="Is or is not"
        className="input w-auto"
        value={c.negate ? "not" : "is"}
        onChange={(e) => onChange({ ...c, negate: e.target.value === "not" })}
      >
        <option value="is">yes</option>
        <option value="not">no (the opposite)</option>
      </select>
      {c.type === "sender" && (
        <select
          aria-label="Comparison"
          className="input w-auto"
          value={c.op}
          onChange={(e) => onChange({ ...c, op: e.target.value as "is" | "contains" | "ends_with" })}
        >
          <option value="is">is exactly</option>
          <option value="contains">contains</option>
          <option value="ends_with">ends with</option>
        </select>
      )}
      {(c.type === "sender" || c.type === "sender_domain" || c.type === "subject_contains" || c.type === "recipient_matches") && (
        <input
          aria-label="Value"
          className={`input w-56 ${c.type === "recipient_matches" ? "font-mono" : ""}`}
          required
          maxLength={200}
          placeholder={
            c.type === "sender_domain"
              ? "example.com"
              : c.type === "recipient_matches"
                ? "^shop-"
                : c.type === "sender"
                  ? "news@example.com"
                  : "invoice"
          }
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      {c.type === "recipient_matches" && (
        <span className="text-xs text-zinc-500">A regular expression, checked against the full alias (e.g. ^news\.).</span>
      )}
      {c.type === "category" && (
        <select
          aria-label="Category"
          className="input w-auto"
          required
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        >
          <option value="">Choose…</option>
          {categories.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      {c.type === "size_over_kb" && (
        <input
          aria-label="Size in KB"
          type="number"
          min={0}
          className="input w-28"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: Math.max(0, Number(e.target.value) || 0) })}
        />
      )}
      {(c.type === "header_exists" || c.type === "header_equals") && (
        <input
          aria-label="Header name"
          className="input w-44 font-mono"
          required
          placeholder="List-Id"
          pattern="[A-Za-z0-9-]+"
          value={c.name}
          onChange={(e) => onChange({ ...c, name: e.target.value })}
        />
      )}
      {c.type === "header_equals" && (
        <input
          aria-label="Header value"
          className="input w-44"
          placeholder="value"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      {c.type === "auth_failed" && (
        <select
          aria-label="Which check"
          className="input w-auto"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value as keyof typeof AUTH_LABELS })}
        >
          {Object.entries(AUTH_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      )}
      {onRemove && (
        <button type="button" className="btn-ghost text-sm" aria-label="Remove this condition" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
