import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../api";
import type { Address, Digest } from "../types";
import { ErrorText, PageHeader, Spinner } from "../components/ui";
import { timeAgo } from "../util";

function List({ title, items, empty, extra }: { title: string; items: Address[]; empty: string; extra?: (a: Address) => string }) {
  return (
    <section className="card p-5" aria-label={title}>
      <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{title} <span className="tabular-nums">({items.length})</span></h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {items.map((a) => (
            <li key={a.id}>
              <Link to={`/addresses/${a.id}`} className="flex items-baseline gap-2 py-1.5 hover:underline">
                <span className="truncate font-medium">{a.site_name}</span>
                <span className="truncate font-mono text-xs text-zinc-500">{a.email}</span>
                {extra && <span className="ml-auto shrink-0 text-xs text-zinc-500">{extra(a)}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DigestPage() {
  const [days, setDays] = useState(7);
  const q = useQuery({ queryKey: ["digest", days], queryFn: () => get<Digest>(`/v1/digest?days=${days}`) });
  const d = q.data;
  return (
    <>
      <PageHeader
        title={days === 7 ? "This week" : `Last ${days} days`}
        subtitle={d ? `${d.received} mail(s) received, ${d.created.length} new address(es)` : undefined}
        actions={
          <select className="input w-auto py-1" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        }
      />
      {q.isLoading && <Spinner />}
      <ErrorText error={q.error} />
      {d && (
        <div className="grid gap-4 lg:grid-cols-2">
          <List
            title="Possible leaks"
            items={d.leaks}
            empty="No address received mail from an unexpected sender."
            extra={(a) => `${a.leak!.sender} · ${timeAgo(a.leak!.at)}`}
          />
          <section className="card p-5" aria-label="Busiest addresses">
            <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Busiest addresses</h2>
            {d.busiest.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">No mail in this period.</p>
            ) : (
              <ul className="mt-2 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {d.busiest.map((b) => (
                  <li key={b.address.id}>
                    <Link to={`/addresses/${b.address.id}`} className="flex items-baseline gap-2 py-1.5 hover:underline">
                      <span className="truncate font-medium">{b.address.site_name}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-zinc-500">{b.count} mail(s)</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <List title="New addresses" items={d.created} empty="No address created in this period." extra={(a) => timeAgo(a.created_at)} />
          <List title="Silent for 30+ days" items={d.silent} empty="Every address has received mail." extra={(a) => `created ${timeAgo(a.created_at)}`} />
        </div>
      )}
    </>
  );
}
