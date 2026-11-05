import { useQuery } from "@tanstack/react-query";
import { get } from "../../api";
import type { AddressStats } from "../../types";
import { Spinner } from "../../components/ui";
import { formatNumber, timeAgo } from "../../util";
import { useT } from "../../i18n";

export function StatsCard({ id }: { id: string }) {
  const stats = useQuery({ queryKey: ["stats", id], queryFn: () => get<AddressStats>(`/v1/addresses/${id}/stats`) });
  const s = stats.data;
  const tr = useT().address;
  const max = Math.max(1, ...(s?.per_week ?? []));
  return (
    <section className="card space-y-3 p-5" aria-labelledby="stats">
      <h2 id="stats" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        {tr.activity}
      </h2>
      {!s ? (
        <Spinner />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-zinc-500">{tr.mails}</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatNumber(s.total)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{tr.withCode}</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatNumber(s.with_code)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{tr.lastMail}</dt>
              <dd className="text-lg font-semibold">{s.last_at ? timeAgo(s.last_at) : "—"}</dd>
            </div>
          </dl>
          <div>
            <p className="text-xs text-zinc-500">{tr.perWeek}</p>
            <div className="mt-1 flex h-12 items-end gap-1" role="img" aria-label={tr.perWeekLabel(s.per_week.join(", "))}>
              {s.per_week.map((n, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-zinc-300 dark:bg-zinc-700"
                  style={{ height: `${Math.max(n ? 8 : 2, (n / max) * 100)}%` }}
                  title={tr.mailCount(n)}
                />
              ))}
            </div>
          </div>
          {s.top_senders.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500">{tr.topSenders}</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {s.top_senders.map((t) => (
                  <li key={t.domain} className="flex justify-between gap-2">
                    <span className="truncate font-mono text-xs">{t.domain}</span>
                    <span className="tabular-nums text-zinc-500">{formatNumber(t.count)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
