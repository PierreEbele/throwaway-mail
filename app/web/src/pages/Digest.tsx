import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api";
import type { Address, Digest, LeakGroup } from "../types";
import { ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../components/ui";
import { formatNumber, fullDate, timeAgo } from "../util";
import { useT } from "../i18n";

function List({ title, items, empty, extra }: { title: string; items: Address[]; empty: string; extra?: (a: Address) => string }) {
  return (
    <section className="card p-5" aria-label={title}>
      <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        {title} <span className="tabular-nums">({formatNumber(items.length)})</span>
      </h2>
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

function LeakHistory() {
  const q = useQuery({ queryKey: ["leaks"], queryFn: () => get<{ leaks: LeakGroup[] }>("/v1/leaks").then((r) => r.leaks) });
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT().overview.digest;
  const block = (g: LeakGroup) =>
    confirmAction(t.confirmBlock(g.sender_domain, g.addresses.length)) &&
    post<{ affected: number }>("/v1/leaks/block", { sender_domain: g.sender_domain }).then(
      (r) => {
        qc.invalidateQueries();
        toast(t.blocked(g.sender_domain, r.affected), "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  return (
    <section className="card p-5 lg:col-span-2" aria-label={t.leakHistory}>
      <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{t.leakTitle}</h2>
      <p className="mt-1 text-xs text-zinc-500">{t.leakHelp}</p>
      {!q.data ? (
        <Spinner />
      ) : q.data.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">{t.noLeak}</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {q.data.map((g) => (
            <li key={g.sender_domain} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-mono font-medium">{g.sender_domain}</span>
              <span className="text-xs text-zinc-500">{t.mails(g.count, timeAgo(g.last_at))}</span>
              <span className="flex flex-wrap gap-1">
                {g.addresses.map((a) => (
                  <Link
                    key={a.id}
                    to={`/addresses/${a.id}`}
                    className="rounded bg-zinc-100 px-1.5 text-xs hover:underline dark:bg-zinc-800"
                  >
                    {a.site_name}
                  </Link>
                ))}
              </span>
              <button className="btn-secondary ml-auto px-2 py-0.5 text-xs" onClick={() => block(g)}>
                {t.blockEverywhere}
              </button>
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
  const t = useT().overview.digest;
  return (
    <>
      <PageHeader
        title={days === 7 ? t.thisWeek : t.lastDays(days)}
        subtitle={d ? t.summary(d.received, d.created.length) : undefined}
        actions={
          <select className="input w-auto py-1" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t.period}>
            <option value={1}>{t.last24}</option>
            <option value={7}>{t.last7}</option>
            <option value={30}>{t.last30}</option>
          </select>
        }
      />
      {q.isLoading && <Spinner />}
      <ErrorText error={q.error} />
      {d && (
        <div className="grid gap-4 lg:grid-cols-2">
          <List title={t.leaks} items={d.leaks} empty={t.noLeaks} extra={(a) => `${a.leak!.sender} · ${timeAgo(a.leak!.at)}`} />
          <section className="card p-5" aria-label={t.busiest}>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{t.busiest}</h2>
            {d.busiest.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">{t.noMail}</p>
            ) : (
              <ul className="mt-2 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {d.busiest.map((b) => (
                  <li key={b.address.id}>
                    <Link to={`/addresses/${b.address.id}`} className="flex items-baseline gap-2 py-1.5 hover:underline">
                      <span className="truncate font-medium">{b.address.site_name}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-zinc-500">{t.mailCount(b.count)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <List title={t.expiring} items={d.expiring} empty={t.noExpiring} extra={(a) => fullDate(a.expires_at)} />
          <List title={t.created} items={d.created} empty={t.noCreated} extra={(a) => timeAgo(a.created_at)} />
          <LeakHistory />
          <List title={t.silent} items={d.silent} empty={t.noSilent} extra={(a) => t.createdAgo(timeAgo(a.created_at))} />
        </div>
      )}
    </>
  );
}
