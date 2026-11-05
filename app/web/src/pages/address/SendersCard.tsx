import { useState, type FormEvent } from "react";
import type { Address } from "../../types";
import { ErrorText } from "../../components/ui";
import { useT } from "../../i18n";
import { useSenderAction } from "./hooks";

export function SendersCard({ a }: { a: Address }) {
  const act = useSenderAction(a.id);
  const [value, setValue] = useState("");
  const t = useT().address;
  const chip = (d: string, undo: string, cls: string) => (
    <span key={d} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs ${cls}`}>
      {d}
      <button
        aria-label={t.removeSender(d)}
        className="opacity-60 hover:opacity-100"
        onClick={() => act.mutate({ action: undo, sender: d })}
      >
        ×
      </button>
    </span>
  );
  return (
    <section className="card space-y-3 p-5" aria-labelledby="senders">
      <h2 id="senders" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        {t.senders}
      </h2>
      <form
        className="flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (value.trim()) act.mutate({ action: "block", sender: value.trim() }, { onSuccess: () => setValue("") });
        }}
      >
        <label className="sr-only" htmlFor="block-sender">
          {t.blockLabel}
        </label>
        <input
          id="block-sender"
          className="input py-1"
          placeholder={t.blockPlaceholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn-secondary shrink-0">{t.block}</button>
      </form>
      <div className="text-sm">
        <p className="text-xs text-zinc-500">{t.blocked}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {a.blocked_senders.length ? (
            a.blocked_senders.map((d) => chip(d, "unblock", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"))
          ) : (
            <span className="text-xs text-zinc-500">{t.none}</span>
          )}
        </div>
      </div>
      {a.trusted_senders.length > 0 && (
        <div className="text-sm">
          <p className="text-xs text-zinc-500">{t.trusted}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {a.trusted_senders.map((d) => chip(d, "untrust", "bg-zinc-100 dark:bg-zinc-800"))}
          </div>
        </div>
      )}
      <ErrorText error={act.error} />
    </section>
  );
}
