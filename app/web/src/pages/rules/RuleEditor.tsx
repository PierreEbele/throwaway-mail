import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch, post } from "../../api";
import type { RuleAction, RuleCondition, RuleTestResult } from "../../types";
import { ErrorText, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { useDestinations } from "../Addresses";
import { useCategories } from "../mailbox/shared";
import { actionLabels, defaultAction, defaultCondition } from "./describe";
import { useT } from "../../i18n";
import { ConditionRow } from "./ConditionRow";
import { useAddresses, type Draft } from "./shared";

export function RuleEditor({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useCategories();
  const dests = useDestinations();
  const addrs = useAddresses();
  const [d, setD] = useState<Draft>(draft);
  const t = useT().rules.editor;
  const tc = useT().common;
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
      toast(d.id ? t.saved : t.created, "success");
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
      aria-label={d.id ? t.editLabel : t.newLabel}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="rule-name" className="label">
            {t.name}
          </label>
          <input
            id="rule-name"
            className="input"
            required
            maxLength={100}
            placeholder={t.namePlaceholder}
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="rule-scope" className="label">
            {t.appliesTo}
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
            <option value="">{t.allAddresses}</option>
            {!!cats.data?.length && (
              <optgroup label={t.inCategory}>
                {cats.data.map((c) => (
                  <option key={c.id} value={`c:${c.id}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
            {!!addrs.data?.length && (
              <optgroup label={t.oneAddress}>
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
          {t.when}{" "}
          <select
            aria-label={t.combine}
            className="input inline-block w-auto py-0.5"
            value={d.match}
            onChange={(e) => set({ match: e.target.value as "all" | "any" })}
          >
            <option value="all">{t.all}</option>
            <option value="any">{t.any}</option>
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
          {t.addCondition}
        </button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">{t.then}</legend>
        {d.actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t.action}
              className="input w-auto"
              value={a.type}
              onChange={(e) => setAct(i, defaultAction(e.target.value as RuleAction["type"]))}
            >
              {Object.entries(actionLabels()).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {a.type === "forward_to" && (
              <select
                aria-label={t.mailbox}
                className="input w-auto"
                required
                value={a.destination_id}
                onChange={(e) => setAct(i, { type: "forward_to", destination_id: e.target.value })}
              >
                <option value="">{t.chooseMailbox}</option>
                {dests.data?.map((x) => (
                  <option key={x.id} value={x.id} disabled={!x.verified}>
                    {x.email}
                    {x.verified ? "" : t.notVerified}
                  </option>
                ))}
              </select>
            )}
            {a.type === "set_category" && (
              <select
                aria-label={t.category}
                className="input w-auto"
                required
                value={a.category_id}
                onChange={(e) => setAct(i, { type: "set_category", category_id: e.target.value })}
              >
                <option value="">{t.chooseCategory}</option>
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
                aria-label={t.removeAction}
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
          {t.addAction}
        </button>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={save.isPending}>
          {d.id ? t.save : t.create}
        </button>
        <button type="button" className="btn-secondary" disabled={test.isPending} onClick={() => test.mutate()}>
          {t.test}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          {tc.cancel}
        </button>
      </div>
      <ErrorText error={save.error ?? test.error} />
      {preview && (
        <div aria-live="polite" className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
          <p className="mb-2 font-medium">{preview.tested === 0 ? t.noMail : t.wouldMatch(preview.matched, preview.tested)}</p>
          <ul className="space-y-1">
            {preview.results.map((r) => (
              <li key={r.message_id} className={r.matched ? "" : "text-zinc-500"}>
                <span aria-label={r.matched ? t.matches : t.noMatch}>{r.matched ? "✓" : "·"}</span> {r.subject ?? tc.noSubject}{" "}
                <span className="text-xs text-zinc-500">{t.from(r.from ?? "?", timeAgo(r.received_at))}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-500">{t.previewNote}</p>
        </div>
      )}
    </form>
  );
}
