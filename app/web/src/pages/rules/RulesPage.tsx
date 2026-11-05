import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../../api";
import type { Rule } from "../../types";
import { EmptyState, ErrorText, PageHeader, Spinner, Toggle, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { describeAction, describeCondition } from "./describe";
import { RuleEditor } from "./RuleEditor";
import { EMPTY, useNames, type Draft } from "./shared";

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
