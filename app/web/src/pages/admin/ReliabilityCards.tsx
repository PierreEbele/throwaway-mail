import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post, put } from "../../api";
import { Toggle, useToast } from "../../components/ui";
import { fullDate, timeAgo } from "../../util";
import { getLang, useT } from "../../i18n";

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
  const t = useT().ops.backup;
  const tc = useT().common;
  const run = useMutation({
    mutationFn: () => post("/v1/admin/backup/run"),
    onSuccess: () => toast(t.done, "success"),
    onError: (e) => toast((e as Error).message, "error"),
    onSettled: () => refresh(qc),
  });
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className={title}>{t.title}</h2>
        <button className="btn-secondary" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? t.running : t.run}
        </button>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        <li>
          {t.schedule}: {b.scheduled_every_hours ? t.every(b.scheduled_every_hours) : t.scheduleOff}
        </li>
        <li>
          {t.offsite}: {b.offsite ? t.offsiteOn : tc.off}
        </li>
        <li title={b.last_success_at ? fullDate(b.last_success_at) : undefined}>
          {t.lastSuccess}: {timeAgo(b.last_success_at)}
          {b.last_file && <span className="ml-1 font-mono text-xs text-zinc-500">{b.last_remote_key ?? b.last_file}</span>}
        </li>
        {b.last_ok === false && <li className="text-red-600">{t.lastFailed(timeAgo(b.last_run_at), b.last_error ?? "")}</li>}
      </ul>
    </section>
  );
}

export function ProbeCard({ p }: { p: ProbeHealth }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT().ops.probe;
  const tb = useT().ops.backup;
  const tc = useT().common;
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
    onSuccess: () => toast(t.saved, "success"),
    onError: (e) => toast((e as Error).message, "error"),
    onSettled: () => refresh(qc),
  });
  const run = useMutation({
    mutationFn: () => post("/v1/admin/probe/run"),
    onSuccess: () => toast(t.sent, "success"),
    onError: (e) => toast((e as Error).message, "error"),
    onSettled: () => refresh(qc),
  });
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className={title}>{t.title}</h2>
        {p.enabled && (
          <button className="btn-secondary" disabled={run.isPending || !!p.pending} onClick={() => run.mutate()}>
            {t.run}
          </button>
        )}
      </div>
      {!p.transport_configured ? (
        <p className="mt-2 text-sm text-zinc-500">{t.unconfigured}</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1 text-sm">
            {p.pending && <li>{t.waiting(timeAgo(p.pending.sent_at))}</li>}
            <li>
              {tb.lastSuccess}: {timeAgo(p.last_success_at)}
              {p.last_latency_ms !== null && (
                <span className="text-zinc-500">
                  {t.took(
                    new Intl.NumberFormat(getLang(), { style: "unit", unit: "second", maximumFractionDigits: 0 }).format(
                      p.last_latency_ms / 1000,
                    ),
                  )}
                </span>
              )}
            </li>
            {p.last_ok === false && <li className="text-red-600">{t.failing(p.consecutive_failures, p.last_error ?? "")}</li>}
          </ul>
          <form
            className="mt-3 grid gap-2 text-sm sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label className="sm:col-span-2">
              {t.address}
              <input
                className="input mt-1"
                type="email"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="probe@your-domain"
              />
            </label>
            <label>
              {t.every}
              <input
                className="input mt-1"
                type="number"
                min={5}
                value={form.interval_minutes}
                onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })}
              />
            </label>
            <label>
              {t.timeout}
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
                <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t.enabledLabel} />
                {t.enabled}
              </span>
              <button className="btn-primary" disabled={save.isPending}>
                {tc.save}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
