import { useQuery } from "@tanstack/react-query";
import { get } from "../../api";
import { Badge, ErrorText, PageHeader, Spinner } from "../../components/ui";
import { formatBytes, formatNumber, timeAgo } from "../../util";
import { getLang, useT } from "../../i18n";
import { BackupCard, ProbeCard, type BackupHealth, type ProbeHealth } from "./ReliabilityCards";

interface Health {
  uptime_s: number;
  db_bytes: number;
  cloudflare: string;
  retention_days: number;
  metrics_enabled: boolean;
  counts: Record<string, number>;
  domains: Array<{
    name: string;
    transport: "cloudflare" | "imap";
    status: string;
    last_ingest_at: number | null;
    last_checked_at: number | null;
    last_poll_at: number | null;
    last_poll_error: string | null;
    dns_missing: number;
  }>;
  ingest: Array<{ action: string; reason: string; count: number }>;
  jobs: Record<string, { at: number; ok: boolean; detail: string }>;
  backup: BackupHealth;
  probe: ProbeHealth;
}

const duration = (s: number) => {
  const [n, unit] = s < 3600 ? [s / 60, "minute"] : s < 86400 ? [s / 3600, "hour"] : [s / 86400, "day"];
  return new Intl.NumberFormat(getLang(), { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 0 }).format(n);
};

export function HealthPage() {
  const q = useQuery({ queryKey: ["admin-health"], queryFn: () => get<Health>("/v1/admin/health"), refetchInterval: 30_000 });
  const h = q.data;
  const t = useT().admin.health;
  const tc = useT().common;
  const stat = (label: string, value: string | number, warn = false) => (
    <div className="card p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${warn ? "text-amber-700 dark:text-amber-400" : ""}`}>
        {typeof value === "number" ? formatNumber(value) : value}
      </p>
    </div>
  );
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      {q.isLoading && <Spinner />}
      <ErrorText error={q.error} />
      {h && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {stat(t.uptime, duration(h.uptime_s))}
            {stat(t.database, formatBytes(h.db_bytes))}
            {stat(t.mails24h, h.counts.messages_24h ?? 0)}
            {stat(t.failingTargets, h.counts.notify_failing ?? 0, (h.counts.notify_failing ?? 0) > 0)}
            {stat(t.users, h.counts.users ?? 0)}
            {stat(t.addresses, h.counts.addresses ?? 0)}
            {stat(t.storedMails, h.counts.messages ?? 0)}
            {stat(t.leaks, h.counts.leaks ?? 0)}
          </div>
          <section className="card p-5">
            <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{t.domains}</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1">{t.domain}</th>
                  <th>{t.status}</th>
                  <th>{t.lastMail}</th>
                  <th>{t.lastCheck}</th>
                </tr>
              </thead>
              <tbody>
                {h.domains.map((d) => {
                  const quiet = !d.last_ingest_at || Date.now() - d.last_ingest_at > 7 * 86400_000;
                  return (
                    <tr key={d.name} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1.5 font-mono">{d.name}</td>
                      <td>
                        <Badge value={d.status === "active" && d.dns_missing ? "error" : d.status} />
                        {d.dns_missing ? <span className="ml-1 text-xs text-red-600">{t.dnsMissing(d.dns_missing)}</span> : null}
                      </td>
                      <td
                        className={quiet ? "text-amber-700 dark:text-amber-400" : ""}
                        title={quiet ? t.quiet(d.transport === "imap") : undefined}
                      >
                        {timeAgo(d.last_ingest_at)}
                      </td>
                      <td>
                        {d.transport === "imap" ? t.poll(timeAgo(d.last_poll_at)) : timeAgo(d.last_checked_at)}
                        {d.last_poll_error && <span className="ml-1 text-xs text-red-600">{d.last_poll_error}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <BackupCard b={h.backup} />
            <ProbeCard p={h.probe} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-5">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{t.ingest}</h2>
              {h.ingest.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">{t.noIngest}</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {[...h.ingest]
                    .sort((a, b) => b.count - a.count)
                    .map((x) => (
                      <li key={`${x.action}-${x.reason}`} className="flex justify-between gap-2">
                        <span>
                          {x.action}
                          {x.reason ? ` · ${x.reason}` : ""}
                        </span>
                        <span className="tabular-nums">{formatNumber(x.count)}</span>
                      </li>
                    ))}
                </ul>
              )}
            </section>
            <section className="card p-5">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{t.jobs}</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {Object.entries(h.jobs).map(([name, j]) => (
                  <li key={name} className="flex flex-wrap justify-between gap-2">
                    <span>{name.replace("_", " ")}</span>
                    <span className={j.ok ? "text-zinc-500" : "text-red-600"}>
                      {j.ok ? t.ok : t.failed} · {timeAgo(j.at)} · {j.detail}
                    </span>
                  </li>
                ))}
                {Object.keys(h.jobs).length === 0 && <li className="text-zinc-500">{t.noRun}</li>}
              </ul>
              <p className="mt-3 text-xs text-zinc-500">
                {t.retention}: {h.retention_days ? t.days(h.retention_days) : tc.off} · Cloudflare:{" "}
                {h.cloudflare === "unconfigured" ? t.cfUnconfigured : h.cloudflare} · Prometheus /metrics:{" "}
                {h.metrics_enabled ? tc.on : t.metricsOff}
              </p>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
