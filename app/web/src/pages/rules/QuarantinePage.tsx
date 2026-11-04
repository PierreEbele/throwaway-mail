import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../../api";
import type { QuarantinedMessage } from "../../types";
import { Badge, EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { fullDate, timeAgo } from "../../util";

export function QuarantinePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ["quarantine"],
    queryFn: () => get<{ messages: QuarantinedMessage[] }>("/v1/quarantine").then((r) => r.messages),
  });
  const done = (m: QuarantinedMessage) => invalidate(qc, ["quarantine"], ["messages", m.address_id], ["addresses"], ["delivery-failures"]);
  const release = useMutation({
    mutationFn: ({ m, forward }: { m: QuarantinedMessage; forward: boolean }) =>
      post<{ forwarded_to: string[]; failed: number }>(`/v1/quarantine/${m.id}/release`, { forward }),
    onSuccess: (r, { m, forward }) => {
      done(m);
      toast(
        !forward
          ? "Released into the inbox"
          : r.failed
            ? "Released, but forwarding failed: see Failed deliveries"
            : r.forwarded_to.length
              ? `Released and forwarded to ${r.forwarded_to.join(", ")}`
              : "Released (forwarding is off for this address)",
        r.failed ? "error" : "success",
      );
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const remove = useMutation({
    mutationFn: (m: QuarantinedMessage) => del(`/v1/quarantine/${m.id}`),
    onSuccess: (_r, m) => {
      done(m);
      toast("Deleted", "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <>
      <PageHeader
        title="Quarantine"
        subtitle="Mail a rule held back: it is stored but was not forwarded. Release it to forward it now, or delete it."
      />
      {list.isLoading && <Spinner />}
      <ErrorText error={list.error} />
      {list.data?.length === 0 && (
        <EmptyState title="Nothing in quarantine">Rules with the "Quarantine it" action put mail here.</EmptyState>
      )}
      {!!list.data?.length && (
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
          {list.data.map((m) => (
            <li key={m.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words">
                  <Link className="hover:underline" to={`/addresses/${m.address_id}?message=${m.id}`}>
                    {m.subject ?? "(no subject)"}
                  </Link>
                </p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  From {m.from_name ? `${m.from_name} <${m.from}>` : (m.from ?? "?")} to {m.address} ({m.site_name})
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span title={fullDate(m.quarantined_at)}>Held {timeAgo(m.quarantined_at)}</span>
                  {m.matched_rules.map((r) => (
                    <Badge key={r.id} value="paused">
                      rule: {r.name}
                    </Badge>
                  ))}
                  {(["spf", "dkim", "dmarc"] as const)
                    .filter((k) => m.auth[k] && m.auth[k] !== "pass")
                    .map((k) => (
                      <Badge key={k} value="error">
                        {k.toUpperCase()}: {m.auth[k]}
                      </Badge>
                    ))}
                </p>
              </div>
              <button className="btn-primary" disabled={release.isPending} onClick={() => release.mutate({ m, forward: true })}>
                Release &amp; forward
              </button>
              <button
                className="btn-secondary"
                disabled={release.isPending}
                onClick={() => release.mutate({ m, forward: false })}
                title="Keep it in the inbox without forwarding it"
              >
                Release only
              </button>
              <button
                className="btn-ghost text-red-600"
                onClick={() => confirmAction("Delete this mail? This cannot be undone.") && remove.mutate(m)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
