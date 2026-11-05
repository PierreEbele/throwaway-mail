import { useQuery } from "@tanstack/react-query";
import { get } from "../../api";
import { Badge, ErrorText, PageHeader, Spinner } from "../../components/ui";
import { timeAgo } from "../../util";
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

const bytes = (n: number) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const duration = (s: number) =>
  s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;

export function HealthPage() {
  const q = useQuery({ queryKey: ["admin-health"], queryFn: () => get<Health>("/v1/admin/health"), refetchInterval: 30_000 });
  const h = q.data;
  const stat = (label: string, value: string | number, warn = false) => (
    <div className="card p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{value}</p>
    </div>
  );
  return (
    <>
      <PageHeader title="Health" subtitle="Refreshes every 30 seconds. Counters reset when the app restarts." />
      {q.isLoading && <Spinner />}
      <ErrorText error={q.error} />
      {h && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {stat("Uptime", duration(h.uptime_s))}
            {stat("Database", bytes(h.db_bytes))}
            {stat("Mails (24 h)", h.counts.messages_24h ?? 0)}
            {stat("Failing notification targets", h.counts.notify_failing ?? 0, (h.counts.notify_failing ?? 0) > 0)}
            {stat("Users", h.counts.users ?? 0)}
            {stat("Addresses", h.counts.addresses ?? 0)}
            {stat("Stored mails", h.counts.messages ?? 0)}
            {stat("Leaks recorded", h.counts.leaks ?? 0)}
          </div>
          <section className="card p-5">
            <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Domains</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1">Domain</th>
                  <th>Status</th>
                  <th>Last mail</th>
                  <th>Last check / poll</th>
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
                        {d.dns_missing ? <span className="ml-1 text-xs text-red-600">{d.dns_missing} DNS record(s) missing</span> : null}
                      </td>
                      <td
                        className={quiet ? "text-amber-700 dark:text-amber-400" : ""}
                        title={
                          quiet
                            ? `No mail for 7 days: check ${d.transport === "imap" ? "the mailbox" : "MX records and the Worker"}`
                            : undefined
                        }
                      >
                        {timeAgo(d.last_ingest_at)}
                      </td>
                      <td>
                        {d.transport === "imap" ? `poll ${timeAgo(d.last_poll_at)}` : timeAgo(d.last_checked_at)}
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
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Ingest since start</h2>
              {h.ingest.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No mail since the app started.</p>
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
                        <span className="tabular-nums">{x.count}</span>
                      </li>
                    ))}
                </ul>
              )}
            </section>
            <section className="card p-5">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Background jobs</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {Object.entries(h.jobs).map(([name, j]) => (
                  <li key={name} className="flex flex-wrap justify-between gap-2">
                    <span>{name.replace("_", " ")}</span>
                    <span className={j.ok ? "text-zinc-500" : "text-red-600"}>
                      {j.ok ? "ok" : "failed"} · {timeAgo(j.at)} · {j.detail}
                    </span>
                  </li>
                ))}
                {Object.keys(h.jobs).length === 0 && <li className="text-zinc-500">No run yet.</li>}
              </ul>
              <p className="mt-3 text-xs text-zinc-500">
                Retention: {h.retention_days ? `${h.retention_days} days` : "off"} · Cloudflare:{" "}
                {h.cloudflare === "unconfigured" ? "not configured (IMAP domains only)" : h.cloudflare} · Prometheus /metrics:{" "}
                {h.metrics_enabled ? "on" : "off (set METRICS_TOKEN)"}
              </p>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
