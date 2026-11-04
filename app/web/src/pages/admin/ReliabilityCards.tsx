import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post, put } from "../../api";
import { Toggle, useToast } from "../../components/ui";
import { fullDate, timeAgo } from "../../util";

export interface BackupHealth {
  last_run_at: number | null;
  last_ok: boolean | null;
  last_error: string | null;
  last_success_at: number | null;
  last_file: string | null;
  last_bytes: number | null;
  last_remote_key: string | null;
  offsite: boolean;
  scheduled_every_hours: number;
}

export interface ProbeHealth {
  enabled: boolean;
  address: string;
  interval_minutes: number;
  timeout_minutes: number;
  transport_configured: boolean;
  pending: { token: string; sent_at: number } | null;
  last_run_at: number | null;
  last_ok: boolean | null;
  last_error: string | null;
  last_success_at: number | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
}

const title = "text-sm font-semibold tracking-wide text-zinc-500 uppercase";
const refresh = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: ["admin-health"] });

export function BackupCard({ b }: { b: BackupHealth }) {
  const qc = useQueryClient();
  const toast = useToast();
  const run = useMutation({
    mutationFn: () => post("/v1/admin/backup/run"),
    onSuccess: () => toast("Backup done", "success"),
    onError: (e) => toast((e as Error).message, "error"),
    onSettled: () => refresh(qc),
  });
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className={title}>Backups</h2>
        <button className="btn-secondary" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Backing up…" : "Back up now"}
        </button>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        <li>
          Schedule:{" "}
          {b.scheduled_every_hours
            ? `every ${b.scheduled_every_hours} h`
            : "off (BACKUP_INTERVAL_HOURS; host cron may run scripts/backup.sh)"}
        </li>
        <li>Off-site copy: {b.offsite ? "on, encrypted (BACKUP_S3_*)" : "off"}</li>
        <li title={b.last_success_at ? fullDate(b.last_success_at) : undefined}>
          Last success: {b.last_success_at ? timeAgo(b.last_success_at) : "never"}
          {b.last_file && <span className="ml-1 font-mono text-xs text-zinc-500">{b.last_remote_key ?? b.last_file}</span>}
        </li>
        {b.last_ok === false && (
          <li className="text-red-600">
            Last run failed {timeAgo(b.last_run_at)}: {b.last_error}
          </li>
        )}
      </ul>
    </section>
  );
}

export function ProbeCard({ p }: { p: ProbeHealth }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    enabled: p.enabled,
    address: p.address,
    interval_minutes: p.interval_minutes,
    timeout_minutes: p.timeout_minutes,
  });
  useEffect(() => {
    setForm({ enabled: p.enabled, address: p.address, interval_minutes: p.interval_minutes, timeout_minutes: p.timeout_minutes });
  }, [p.enabled, p.address, p.interval_minutes, p.timeout_minutes]);
  const save = useMutation({
    mutationFn: () => put("/v1/admin/probe", form),
    onSuccess: () => toast("Probe saved", "success"),
    onError: (e) => toast((e as Error).message, "error"),
    onSettled: () => refresh(qc),
  });
  const run = useMutation({
    mutationFn: () => post("/v1/admin/probe/run"),
    onSuccess: () => toast("Probe mail sent", "success"),
    onError: (e) => toast((e as Error).message, "error"),
    onSettled: () => refresh(qc),
  });
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className={title}>Delivery probe</h2>
        {p.enabled && (
          <button className="btn-secondary" disabled={run.isPending || !!p.pending} onClick={() => run.mutate()}>
            Run now
          </button>
        )}
      </div>
      {!p.transport_configured ? (
        <p className="mt-2 text-sm text-zinc-500">Set PROBE_SMTP_URL to send a test mail to one of your addresses periodically.</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1 text-sm">
            {p.pending && <li>Waiting for the probe sent {timeAgo(p.pending.sent_at)}…</li>}
            <li>
              Last success: {p.last_success_at ? timeAgo(p.last_success_at) : "never"}
              {p.last_latency_ms !== null && <span className="text-zinc-500"> · took {Math.round(p.last_latency_ms / 1000)} s</span>}
            </li>
            {p.last_ok === false && (
              <li className="text-red-600">
                Failing ({p.consecutive_failures}×): {p.last_error}
              </li>
            )}
          </ul>
          <form
            className="mt-3 grid gap-2 text-sm sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label className="sm:col-span-2">
              Probe address (an address of this instance that stores mail)
              <input
                className="input mt-1"
                type="email"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="probe@your-domain"
              />
            </label>
            <label>
              Every (minutes)
              <input
                className="input mt-1"
                type="number"
                min={5}
                value={form.interval_minutes}
                onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })}
              />
            </label>
            <label>
              Timeout (minutes)
              <input
                className="input mt-1"
                type="number"
                min={1}
                value={form.timeout_minutes}
                onChange={(e) => setForm({ ...form, timeout_minutes: Number(e.target.value) })}
              />
            </label>
            <div className="flex items-center justify-between gap-2 sm:col-span-2">
              <span className="flex items-center gap-2">
                <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Probe enabled" />
                Enabled
              </span>
              <button className="btn-primary" disabled={save.isPending}>
                Save
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
