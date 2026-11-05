import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api";
import type { DeliveryFailure } from "../../types";
import { Badge, EmptyState, ErrorText, PageHeader, Spinner, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { fullDate, timeAgo } from "../../util";
import { useDestinations } from "../Addresses";
import { useT } from "../../i18n";

export function DeliveriesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const dests = useDestinations();
  const t = useT().rules.deliveries;
  const tc = useT().common;
  const KIND_LABELS = t.kinds;
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [kind, setKind] = useState("");
  const [destination, setDestination] = useState("");
  const params = new URLSearchParams({ status, ...(kind ? { kind } : {}), ...(destination ? { destination } : {}), limit: "200" });
  const list = useQuery({
    queryKey: ["delivery-failures", status, kind, destination],
    queryFn: () => get<{ failures: DeliveryFailure[] }>(`/v1/delivery-failures?${params}`).then((r) => r.failures),
  });
  const inv = () => invalidate(qc, ["delivery-failures"]);
  const retry = useMutation({
    mutationFn: (f: DeliveryFailure) => post<{ delivered: boolean; failure: DeliveryFailure }>(`/v1/delivery-failures/${f.id}/retry`),
    onSuccess: (r) => {
      inv();
      toast(r.delivered ? t.delivered : t.stillFailing(r.failure.reason), r.delivered ? "success" : "error");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const dismiss = useMutation({ mutationFn: (f: DeliveryFailure) => post(`/v1/delivery-failures/${f.id}/dismiss`), onSuccess: inv });
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3" role="group" aria-label={t.filters}>
        <div>
          <label htmlFor="f-status" className="label">
            {t.show}
          </label>
          <select id="f-status" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="open">{t.open}</option>
            <option value="resolved">{t.resolved}</option>
            <option value="all">{t.all}</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-kind" className="label">
            {t.kind}
          </label>
          <select id="f-kind" className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t.any}</option>
            {Object.entries(KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-dest" className="label">
            {t.mailbox}
          </label>
          <select id="f-dest" className="input w-auto" value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value="">{t.any}</option>
            {dests.data?.map((d) => (
              <option key={d.id} value={d.email}>
                {d.email}
              </option>
            ))}
          </select>
        </div>
      </div>
      {list.isLoading && <Spinner />}
      <ErrorText error={list.error} />
      {list.data?.length === 0 && <EmptyState title={t.emptyTitle}>{t.emptyBody}</EmptyState>}
      {!!list.data?.length && (
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
          {list.data.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge value={f.kind === "failed" ? "pending" : "error"}>{KIND_LABELS[f.kind]}</Badge>
                  <span className="font-mono text-sm">{f.destination}</span>
                  {f.resolved_at && <Badge value="verified">{t.resolvedBadge}</Badge>}
                </p>
                <p className="mt-1 text-sm">{f.reason}</p>
                {f.delivered_to && <p className="text-sm text-emerald-700 dark:text-emerald-400">{t.fallback(f.delivered_to)}</p>}
                <p className="text-xs text-zinc-500">
                  {f.message_id && f.address_id ? (
                    <Link className="hover:underline" to={`/addresses/${f.address_id}?message=${f.message_id}`}>
                      {f.subject ?? tc.noSubject}
                    </Link>
                  ) : (
                    t.messageDeleted
                  )}{" "}
                  · {f.from ?? "?"} → {f.address ?? "?"} · <span title={fullDate(f.created_at)}>{timeAgo(f.created_at)}</span> ·{" "}
                  {f.transport === "cloudflare" ? t.viaCf : t.viaSmtp}
                  {f.retry_count > 0 && t.retried(f.retry_count)}
                </p>
                {f.detail && (
                  <details className="mt-1 text-xs text-zinc-500">
                    <summary className="cursor-pointer">{t.technical}</summary>
                    <code className="break-all">{f.detail}</code>
                  </details>
                )}
              </div>
              {!f.resolved_at && (
                <>
                  <button
                    className="btn-secondary"
                    disabled={!f.can_retry || retry.isPending}
                    title={f.can_retry ? t.retryTitle : t.retryUnavailable}
                    onClick={() => retry.mutate(f)}
                  >
                    {t.retry}
                  </button>
                  <button className="btn-ghost" onClick={() => dismiss.mutate(f)}>
                    {t.dismiss}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
