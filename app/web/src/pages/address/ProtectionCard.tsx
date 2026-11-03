import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address } from "../../types";
import { CopyButton, Toggle } from "../../components/ui";
import { hostOf } from "../../util";
import { useReplace } from "./hooks";

function FeedRow({ a }: { a: Address }) {
  const qc = useQueryClient();
  const set = (enabled: boolean) =>
    post<{ address: Address }>(`/v1/addresses/${a.id}/feed`, { enabled }).then((r) => qc.setQueryData(["address", a.id], r.address));
  const base = `${location.origin}/feeds/${a.feed_token}`;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span>
          Private RSS / JSON feed
          <span className="block text-xs text-zinc-500">
            For a feed reader or Home Assistant. Anyone with the link can read this address&apos;s mail.
          </span>
        </span>
        <Toggle id="feed-toggle" checked={!!a.feed_token} onChange={set} label="Private feed" />
      </div>
      {a.feed_token && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <CopyButton text={`${base}.rss`} label="Copy RSS URL" />
          <CopyButton text={`${base}.json`} label="Copy JSON URL" />
          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => set(true)} title="Invalidate the old URLs">
            Rotate
          </button>
        </div>
      )}
    </div>
  );
}

export function ProtectionCard({ a, onChange }: { a: Address; onChange: (b: Record<string, unknown>) => void }) {
  const [max, setMax] = useState(a.max_messages ? String(a.max_messages) : "");
  const replace = useReplace(a);
  return (
    <section className="card space-y-3 p-5" aria-labelledby="protection">
      <h2 id="protection" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        Protection
      </h2>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="lock-toggle" className="text-sm">
          Only accept mail from {hostOf(a.site_url) ?? "the site"}
          <span className="block text-xs text-zinc-500">
            {a.site_url ? "Other senders are rejected and logged as leaks." : "Set the site URL first."}
          </span>
        </label>
        <Toggle id="lock-toggle" checked={a.site_lock} onChange={(v) => onChange({ site_lock: v })} label="Lock to the site" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="burn-code" className="text-sm">
          Burn after the first code
          <span className="block text-xs text-zinc-500">
            For one-shot sign-ups: the address stops accepting mail once its code arrived.
          </span>
        </label>
        <Toggle
          id="burn-code"
          checked={a.burn_after_code}
          onChange={(v) => onChange({ burn_after_code: v })}
          label="Burn after the first code"
        />
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
            Burn after N mails
          </label>
          <input
            id="max-msg"
            type="number"
            min={1}
            className="input py-1"
            placeholder="Unlimited"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </div>
        <button className="btn-secondary">Save</button>
      </form>
      <FeedRow a={a} />
      <button className="btn-secondary w-full" onClick={replace}>
        Replace with a fresh address…
      </button>
    </section>
  );
}
