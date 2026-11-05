import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post, put } from "../../api";
import type { AddressSettings, AddressSettingsResponse, AliasFormat, RotationMode } from "../../types";
import { ErrorText, Spinner, useToast } from "../../components/ui";
import { useAddressSettings } from "../Addresses";
import { useT } from "../../i18n";

/** Format of random local parts and defaults applied to new addresses (UI, API, SDK, extension, Bitwarden). */
export function AddressSettingsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAddressSettings();
  const t = useT().addressPrefs.settings;
  const tc = useT().common;
  const FORMATS: Record<AliasFormat, string> = t.formats;
  const [s, setS] = useState<AddressSettings | null>(null);
  const [examples, setExamples] = useState<string[]>([]);
  useEffect(() => {
    if (q.data && !s) {
      setS(q.data.settings);
      setExamples(q.data.examples);
    }
  }, [q.data, s]);
  const preview = useMutation({
    mutationFn: (next: AddressSettings) => post<{ examples: string[] }>("/v1/settings/addresses/preview", next),
    onSuccess: (r) => setExamples(r.examples),
  });
  const save = useMutation({
    mutationFn: () => put<AddressSettingsResponse>("/v1/settings/addresses", s),
    onSuccess: (r) => {
      qc.setQueryData(["address-settings"], r);
      setExamples(r.examples);
      toast(t.saved, "success");
    },
  });
  // Live examples while editing (debounced).
  useEffect(() => {
    if (!s) return;
    if (s.format === "template" && !s.template) return;
    const timer = setTimeout(() => preview.mutate(s), 400);
    return () => clearTimeout(timer);
  }, [s?.format, s?.length, s?.template]);
  if (!s) return <div className="card mt-4 max-w-xl p-5">{q.error ? <ErrorText error={q.error} /> : <Spinner />}</div>;
  const set = (patch: Partial<AddressSettings>) => setS({ ...s, ...patch });
  const num = (v: string) => (v.trim() ? Math.max(1, Math.floor(Number(v))) : null);
  return (
    <form
      className="card mt-4 max-w-xl space-y-3 p-5 text-sm"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="font-semibold">{t.title}</h2>
      <p className="text-zinc-500">{t.help}</p>
      <div>
        <label htmlFor="as-format" className="label">
          {t.format}
        </label>
        <select id="as-format" className="input" value={s.format} onChange={(e) => set({ format: e.target.value as AliasFormat })}>
          {Object.entries(FORMATS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {s.format === "random" && (
        <div>
          <label htmlFor="as-length" className="label">
            {t.length}
          </label>
          <input
            id="as-length"
            className="input w-28"
            type="number"
            min={6}
            max={32}
            value={s.length}
            onChange={(e) => set({ length: Math.min(32, Math.max(6, Number(e.target.value) || 12)) })}
          />
        </div>
      )}
      {s.format === "template" && (
        <div>
          <label htmlFor="as-template" className="label">
            {t.template}
          </label>
          <input
            id="as-template"
            className="input font-mono"
            placeholder="{word}-{rand6}"
            value={s.template ?? ""}
            onChange={(e) => set({ template: e.target.value.toLowerCase() })}
          />
          <p className="mt-1 text-xs text-zinc-500">
            <code>{"{word}"}</code> {t.tWord} <code>{"{rand6}"}</code> {t.tRand} <code>{"{digits4}"}</code> {t.tDigits}{" "}
            <code>{"{site}"}</code> {t.tSite}
          </p>
        </div>
      )}
      <p className="text-xs text-zinc-500">
        {t.examples}{" "}
        {preview.error ? (
          <span className="text-red-600">{preview.error.message}</span>
        ) : (
          examples.map((x) => (
            <code key={x} className="mr-2 font-mono">
              {x}
            </code>
          ))
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="as-expiry" className="label">
            {t.expiry} <span className="font-normal text-zinc-400">{t.expiryHint}</span>
          </label>
          <input
            id="as-expiry"
            className="input"
            type="number"
            min={1}
            max={3650}
            value={s.default_expires_in_days ?? ""}
            onChange={(e) => set({ default_expires_in_days: num(e.target.value) })}
          />
        </div>
        <div>
          <label htmlFor="as-max" className="label">
            {t.max} <span className="font-normal text-zinc-400">{t.maxHint}</span>
          </label>
          <input
            id="as-max"
            className="input"
            type="number"
            min={1}
            max={100000}
            value={s.default_max_messages ?? ""}
            onChange={(e) => set({ default_max_messages: num(e.target.value) })}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="as-rot-mode" className="label">
            {t.rotate}
          </label>
          <select
            id="as-rot-mode"
            className="input"
            value={s.rotation_mode}
            onChange={(e) => set({ rotation_mode: e.target.value as RotationMode })}
          >
            <option value="off">{t.never}</option>
            <option value="after_leak">{t.afterLeak}</option>
            <option value="every">{t.every}</option>
          </select>
        </div>
        <div>
          <label htmlFor="as-rot-days" className="label">
            N <span className="font-normal text-zinc-400">{t.days}</span>
          </label>
          <input
            id="as-rot-days"
            className="input"
            type="number"
            min={0}
            max={3650}
            value={s.rotation_days}
            onChange={(e) => set({ rotation_days: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </div>
        <div>
          <label htmlFor="as-rot-grace" className="label">
            {t.grace} <span className="font-normal text-zinc-400">{t.days}</span>
          </label>
          <input
            id="as-rot-grace"
            className="input"
            type="number"
            min={0}
            max={365}
            value={s.rotation_grace_days}
            onChange={(e) => set({ rotation_grace_days: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">{t.rotationHelp}</p>
      <ErrorText error={save.error} />
      <button className="btn-primary" disabled={save.isPending}>
        {tc.save}
      </button>
    </form>
  );
}
