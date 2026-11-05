import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address } from "../../types";
import { CopyButton, Toggle } from "../../components/ui";
import { useT } from "../../i18n";
import { hostOf } from "../../util";
import { useReplace } from "./hooks";

function FeedRow({ a }: { a: Address }) {
  const qc = useQueryClient();
  const set = (enabled: boolean) =>
    post<{ address: Address }>(`/v1/addresses/${a.id}/feed`, { enabled }).then((r) => qc.setQueryData(["address", a.id], r.address));
  const base = `${location.origin}/feeds/${a.feed_token}`;
  const t = useT().addressCards.protection;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span>
          {t.feed}
          <span className="block text-xs text-zinc-500">{t.feedHelp}</span>
        </span>
        <Toggle id="feed-toggle" checked={!!a.feed_token} onChange={set} label={t.feedLabel} />
      </div>
      {a.feed_token && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <CopyButton text={`${base}.rss`} label={t.copyRss} />
          <CopyButton text={`${base}.json`} label={t.copyJson} />
          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => set(true)} title={t.rotateTitle}>
            {t.rotate}
          </button>
        </div>
      )}
    </div>
  );
}

export function ProtectionCard({ a, onChange }: { a: Address; onChange: (b: Record<string, unknown>) => void }) {
  const [max, setMax] = useState(a.max_messages ? String(a.max_messages) : "");
  const replace = useReplace(a);
  const t = useT().addressCards.protection;
  const tc = useT().common;
  return (
    <section className="card space-y-3 p-5" aria-labelledby="protection">
      <h2 id="protection" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        {t.title}
      </h2>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="lock-toggle" className="text-sm">
          {t.onlyFrom(hostOf(a.site_url) ?? t.theSite)}
          <span className="block text-xs text-zinc-500">{a.site_url ? t.lockHelp : t.setUrl}</span>
        </label>
        <Toggle id="lock-toggle" checked={a.site_lock} onChange={(v) => onChange({ site_lock: v })} label={t.lockLabel} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="burn-code" className="text-sm">
          {t.burnCode}
          <span className="block text-xs text-zinc-500">{t.burnCodeHelp}</span>
        </label>
        <Toggle id="burn-code" checked={a.burn_after_code} onChange={(v) => onChange({ burn_after_code: v })} label={t.burnCode} />
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onChange({ max_messages: max ? Number(max) : null });
        }}
      >
        <div className="flex-1">
          <label htmlFor="max-msg" className="label">
            {t.burnN}
          </label>
          <input
            id="max-msg"
            type="number"
            min={1}
            className="input py-1"
            placeholder={t.unlimited}
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </div>
        <button className="btn-secondary">{tc.save}</button>
      </form>
      <FeedRow a={a} />
      <button className="btn-secondary w-full" onClick={replace}>
        {t.replace}
      </button>
    </section>
  );
}
