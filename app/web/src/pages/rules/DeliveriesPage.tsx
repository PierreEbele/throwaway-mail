import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api";
import type { DeliveryFailure } from "../../types";
import { Badge, EmptyState, ErrorText, PageHeader, Spinner, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { fullDate, timeAgo } from "../../util";
import { useDestinations } from "../Addresses";

const KIND_LABELS = { failed: "Failed", rejected: "Refused", bounced: "Bounced" } as const;

export function DeliveriesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const dests = useDestinations();
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
      toast(r.delivered ? "Delivered" : `Still failing: ${r.failure.reason}`, r.delivered ? "success" : "error");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const dismiss = useMutation({ mutationFn: (f: DeliveryFailure) => post(`/v1/delivery-failures/${f.id}/dismiss`), onSuccess: inv });
  return (
    <>
      <PageHeader
        title="Failed deliveries"
        subtitle="Forwards that did not reach your mailbox, and why. The mail itself is always kept here, in the app."
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3" role="group" aria-label="Filters">
        <div>
          <label htmlFor="f-status" className="label">
            Show
          </label>
          <select id="f-status" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="open">Needs attention</option>
            <option value="resolved">Resolved or dismissed</option>
            <option value="all">Everything</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-kind" className="label">
            Kind
          </label>
          <select id="f-kind" className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any</option>
            {Object.entries(KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-dest" className="label">
            Mailbox
          </label>
          <select id="f-dest" className="input w-auto" value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value="">Any</option>
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
      {list.data?.length === 0 && <EmptyState title="No failed deliveries">Every forward reached its mailbox.</EmptyState>}
      {!!list.data?.length && (
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
          {list.data.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge value={f.kind === "failed" ? "pending" : "error"}>{KIND_LABELS[f.kind]}</Badge>
                  <span className="font-mono text-sm">{f.destination}</span>
                  {f.resolved_at && <Badge value="verified">resolved</Badge>}
                </p>
                <p className="mt-1 text-sm">{f.reason}</p>
                {f.delivered_to && (
                  <p className="text-sm text-emerald-700 dark:text-emerald-400">Delivered to the fallback {f.delivered_to} instead.</p>
                )}
                <p className="text-xs text-zinc-500">
                  {f.message_id && f.address_id ? (
                    <Link className="hover:underline" to={`/addresses/${f.address_id}?message=${f.message_id}`}>
                      {f.subject ?? "(no subject)"}
                    </Link>
                  ) : (
                    "(message deleted)"
                  )}{" "}
                  · {f.from ?? "?"} → {f.address ?? "?"} · <span title={fullDate(f.created_at)}>{timeAgo(f.created_at)}</span> ·{" "}
                  {f.transport === "cloudflare" ? "via Cloudflare" : "via SMTP"}
                  {f.retry_count > 0 && ` · retried ${f.retry_count}×`}
                </p>
                {f.detail && (
                  <details className="mt-1 text-xs text-zinc-500">
                    <summary className="cursor-pointer">Technical details</summary>
                    <code className="break-all">{f.detail}</code>
                  </details>
                )}
              </div>
              {!f.resolved_at && (
                <>
                  <button
                    className="btn-secondary"
                    disabled={!f.can_retry || retry.isPending}
                    title={
                      f.can_retry
                        ? "Send it again to this mailbox"
                        : "A retry needs the original (kept 3 days) and an outgoing SMTP server (IMAP domain or SMTP_RELAY_URL)"
                    }
                    onClick={() => retry.mutate(f)}
                  >
                    Retry
                  </button>
                  <button className="btn-ghost" onClick={() => dismiss.mutate(f)}>
                    Dismiss
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
