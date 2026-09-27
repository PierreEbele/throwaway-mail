import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api";
import { EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../components/ui";
import { timeAgo } from "../util";

export interface ReviewItem {
  recipient: string;
  domain: string;
  count: number;
  unread: number;
  first_received_at: number;
  last_received_at: number;
  forwarded_to: string | null;
  sender_domains: string[];
  recent: Array<{ id: string; from: string | null; subject: string | null; received_at: number; forwarded: boolean }>;
  suggestion: { siteName: string; siteUrl: string | null };
  registrable: boolean;
}

export function useReviewCount(enabled = true) {
  return useQuery({ queryKey: ["review-count"], queryFn: () => get<{ count: number; unread: number }>("/v1/review/count"), enabled, refetchInterval: 60_000 });
}

function Item({ item }: { item: ReviewItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [siteName, setSiteName] = useState(item.suggestion.siteName);
  const [siteUrl, setSiteUrl] = useState(item.suggestion.siteUrl?.replace(/^https:\/\//, "") ?? "");
  const [forward, setForward] = useState(!!item.forwarded_to);
  const done = () => {
    qc.invalidateQueries({ queryKey: ["review"] });
    qc.invalidateQueries({ queryKey: ["review-count"] });
    qc.invalidateQueries({ queryKey: ["addresses"] });
  };
  const register = useMutation({
    mutationFn: (block: boolean) =>
      post<{ address: { id: string } }>("/v1/review/register", { recipient: item.recipient, site_name: siteName || item.recipient, site_url: siteUrl || undefined, forward, block }),
    onSuccess: (_r, block) => {
      done();
      toast(block ? `${item.recipient} blocked: new mail will be rejected` : `${item.recipient} registered for ${siteName}`, "success");
    },
  });
  const dismiss = useMutation({
    mutationFn: () => post("/v1/review/dismiss", { recipient: item.recipient }),
    onSuccess: () => {
      done();
      toast(`Stored mail for ${item.recipient} deleted`, "success");
    },
  });
  const id = item.recipient.replace(/\W/g, "-");
  return (
    <li className="card p-4" data-testid={`review-${item.recipient}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono font-medium break-all">{item.recipient}</span>
          {item.unread > 0 && <span className="badge ml-2 bg-indigo-600 text-white">{item.unread} new</span>}
        </div>
        <span className="text-xs text-zinc-500">
          {item.count} mail{item.count > 1 ? "s" : ""} · last {timeAgo(item.last_received_at)}
          {item.forwarded_to && <> · forwarded to {item.forwarded_to}</>}
        </span>
      </div>
      <ul className="mt-2 space-y-0.5 text-sm text-zinc-600 dark:text-zinc-400">
        {item.recent.slice(0, 3).map((m) => (
          <li key={m.id} className="truncate">
            <span className="text-zinc-500">{m.from}</span> — {m.subject ?? "(no subject)"}
          </li>
        ))}
      </ul>
      {item.registrable ? (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            register.mutate(false);
          }}
        >
          <div>
            <label htmlFor={`rv-name-${id}`} className="label">Site name</label>
            <input id={`rv-name-${id}`} className="input" required value={siteName} onChange={(e) => setSiteName(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`rv-url-${id}`} className="label">Site URL</label>
            <input id={`rv-url-${id}`} className="input" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="example.com" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={register.isPending}>Register</button>
            <button type="button" className="btn-secondary" onClick={() => confirmAction(`Block ${item.recipient}? New mail to it will be rejected.`) && register.mutate(true)}>
              Block
            </button>
            <button type="button" className="btn-ghost" onClick={() => dismiss.mutate()} title="Delete the stored copies; the address keeps following the domain's catch-all">
              Ignore
            </button>
          </div>
          {item.forwarded_to && (
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input type="checkbox" checked={forward} onChange={(e) => setForward(e.target.checked)} className="size-4 accent-indigo-600" />
              Keep forwarding this site's mail to {item.forwarded_to}
            </label>
          )}
        </form>
      ) : (
        <div className="mt-3 flex items-center gap-3 text-sm text-zinc-500">
          This name cannot be registered as an address.
          <button className="btn-ghost" onClick={() => dismiss.mutate()}>Ignore</button>
        </div>
      )}
      <ErrorText error={register.error ?? dismiss.error} />
    </li>
  );
}

export function ReviewPage() {
  const review = useQuery({ queryKey: ["review"], queryFn: () => get<{ items: ReviewItem[] }>("/v1/review").then((r) => r.items) });
  return (
    <>
      <PageHeader
        title="To sort"
        subtitle="Mail that reached addresses the app doesn't know yet, on domains you added. Register each one as a site, block it, or ignore it."
      />
      {review.isLoading && <Spinner />}
      <ErrorText error={review.error} />
      {review.data?.length === 0 && (
        <EmptyState title="Nothing to sort">
          Mail to unknown addresses lands here when a domain kept its previous catch-all, or uses the “inbox” policy. See <Link className="underline" to="/admin/domains">Domains</Link>.
        </EmptyState>
      )}
      <ul className="space-y-3">
        {review.data?.map((i) => <Item key={i.recipient} item={i} />)}
      </ul>
    </>
  );
}
