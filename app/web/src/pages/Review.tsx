import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api";
import { EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../components/ui";
import { timeAgo } from "../util";
import { invalidateReview } from "../queries";
import { useT } from "../i18n";

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
  return useQuery({
    queryKey: ["review-count"],
    queryFn: () => get<{ count: number; unread: number }>("/v1/review/count"),
    enabled,
    refetchInterval: 60_000,
  });
}

function Item({ item }: { item: ReviewItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [siteName, setSiteName] = useState(item.suggestion.siteName);
  const [siteUrl, setSiteUrl] = useState(item.suggestion.siteUrl?.replace(/^https:\/\//, "") ?? "");
  const [forward, setForward] = useState(!!item.forwarded_to);
  const t = useT().overview.review;
  const tc = useT().common;
  const done = () => invalidateReview(qc);
  const register = useMutation({
    mutationFn: (block: boolean) =>
      post<{ address: { id: string } }>("/v1/review/register", {
        recipient: item.recipient,
        site_name: siteName || item.recipient,
        site_url: siteUrl || undefined,
        forward,
        block,
      }),
    onSuccess: (_r, block) => {
      done();
      toast(block ? t.blocked(item.recipient) : t.registered(item.recipient, siteName), "success");
    },
  });
  const dismiss = useMutation({
    mutationFn: () => post("/v1/review/dismiss", { recipient: item.recipient }),
    onSuccess: () => {
      done();
      toast(t.dismissed(item.recipient), "success");
    },
  });
  const id = item.recipient.replace(/\W/g, "-");
  return (
    <li className="card p-4" data-testid={`review-${item.recipient}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono font-medium break-all">{item.recipient}</span>
          {item.unread > 0 && (
            <span className="badge ml-2 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">{t.newCount(item.unread)}</span>
          )}
        </div>
        <span className="text-xs text-zinc-500">
          {t.mails(item.count, timeAgo(item.last_received_at))}
          {item.forwarded_to && t.forwardedTo(item.forwarded_to)}
        </span>
      </div>
      <ul className="mt-2 space-y-0.5 text-sm text-zinc-600 dark:text-zinc-400">
        {item.recent.slice(0, 3).map((m) => (
          <li key={m.id} className="truncate">
            <span className="text-zinc-500">{m.from}</span>: {m.subject ?? tc.noSubject}
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
            <label htmlFor={`rv-name-${id}`} className="label">
              {t.siteName}
            </label>
            <input id={`rv-name-${id}`} className="input" required value={siteName} onChange={(e) => setSiteName(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`rv-url-${id}`} className="label">
              {t.siteUrl}
            </label>
            <input
              id={`rv-url-${id}`}
              className="input"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="example.com"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={register.isPending}>
              {t.register}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => confirmAction(t.confirmBlock(item.recipient)) && register.mutate(true)}
            >
              {t.block}
            </button>
            <button type="button" className="btn-ghost" onClick={() => dismiss.mutate()} title={t.ignoreTitle}>
              {t.ignore}
            </button>
          </div>
          {item.forwarded_to && (
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input type="checkbox" checked={forward} onChange={(e) => setForward(e.target.checked)} className="size-4 accent-zinc-900" />
              {t.keepForwarding(item.forwarded_to)}
            </label>
          )}
        </form>
      ) : (
        <div className="mt-3 flex items-center gap-3 text-sm text-zinc-500">
          {t.notRegistrable}
          <button className="btn-ghost" onClick={() => dismiss.mutate()}>
            {t.ignore}
          </button>
        </div>
      )}
      <ErrorText error={register.error ?? dismiss.error} />
    </li>
  );
}

export function ReviewPage() {
  const review = useQuery({ queryKey: ["review"], queryFn: () => get<{ items: ReviewItem[] }>("/v1/review").then((r) => r.items) });
  const t = useT().overview.review;
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      {review.isLoading && <Spinner />}
      <ErrorText error={review.error} />
      {review.data?.length === 0 && (
        <EmptyState title={t.emptyTitle}>
          {t.emptyBody}{" "}
          <Link className="underline" to="/admin/domains">
            {t.domains}
          </Link>
          .
        </EmptyState>
      )}
      <ul className="space-y-3">
        {review.data?.map((i) => (
          <Item key={i.recipient} item={i} />
        ))}
      </ul>
    </>
  );
}
