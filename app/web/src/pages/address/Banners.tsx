import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api";
import type { Address, UnsubscribeOffer } from "../../types";
import { useToast } from "../../components/ui";
import { useT } from "../../i18n";
import { invalidate } from "../../queries";
import { fullDate, hostOf, timeAgo } from "../../util";
import { useReplace, useSenderAction, useSiteRejected } from "./hooks";

export function ExpiryBanner({ a }: { a: Address }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT().addressHeader;
  const left = a.expires_at! - Date.now();
  if (left > 3 * 86400_000) return null;
  const extend = (days: number | null) =>
    post<{ address: Address }>(`/v1/addresses/${a.id}/extend`, { days }).then(
      (r) => {
        qc.setQueryData(["address", a.id], r.address);
        invalidate(qc, ["addresses"]);
        toast(days ? t.extended(days) : t.expiryRemoved, "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  const btn = "rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/50";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="flex-1">{left <= 0 ? t.hasExpired : t.expiresIn(timeAgo(a.expires_at!), fullDate(a.expires_at!))}</span>
      <button className={btn} onClick={() => extend(7)}>
        {t.plusDays(7)}
      </button>
      <button className={btn} onClick={() => extend(30)}>
        {t.plusDays(30)}
      </button>
      <button className={btn} onClick={() => extend(null)}>
        {t.neverExpire}
      </button>
    </div>
  );
}

/** An address created for a sign-up that received nothing yet: the site may not have sent its code, or reject the domain. */
export function NoMailBanner({ a }: { a: Address }) {
  const rejected = useSiteRejected(a);
  const t = useT().addressHeader;
  const btn = "rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/50";
  return (
    <div
      data-testid="no-mail-warning"
      className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <span className="flex-1">
        {t.noMail(timeAgo(a.created_at))} <code className="font-mono">{a.domain}</code>.
      </span>
      <button className={btn} onClick={rejected}>
        {t.siteRejected}
      </button>
    </div>
  );
}

export function LeakBanner({ a, onPause }: { a: Address; onPause: () => void }) {
  const act = useSenderAction(a.id);
  const replace = useReplace(a);
  const t = useT().addressHeader;
  const btn = "rounded border border-red-300 px-2 py-0.5 hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/50";
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
    >
      <p>
        <strong>{t.possibleLeak}</strong> {t.leak1(timeAgo(a.leak!.at))} <code className="font-mono">{a.leak!.sender}</code>
        {t.leak2(hostOf(a.site_url) ?? a.site_name)}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <button className={`${btn} font-semibold`} onClick={replace} title={t.replaceTitle}>
          {t.replace}
        </button>
        <button className={btn} onClick={() => act.mutate({ action: "block" })}>
          {t.blockSender}
        </button>
        {a.status === "active" && (
          <button className={btn} onClick={onPause}>
            {t.burn}
          </button>
        )}
        <button className={btn} onClick={() => act.mutate({ action: "trust" })}>
          {t.trust}
        </button>
        <button className={btn} onClick={() => act.mutate({ action: "dismiss" })}>
          {t.dismiss}
        </button>
      </div>
    </div>
  );
}

const dismissKey = (o: UnsubscribeOffer) => `unsub-dismissed:${o.from ?? ""}:${o.url ?? o.mailto ?? ""}`;

/** Offers to unsubscribe from the best newsletter target found in this address's mail. */
export function UnsubscribeBanner({ a }: { a: Address }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [, rerender] = useState(0);
  const t = useT().addressHeader;
  const ta = useT().address;
  const q = useQuery({
    queryKey: ["address", a.id, "unsubscribe"],
    queryFn: () => get<{ offer: UnsubscribeOffer | null; senders: number }>(`/v1/addresses/${a.id}/unsubscribe`),
  });
  const o = q.data?.offer;
  if (!o || localStorage.getItem(dismissKey(o)) === "1") return null;
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<{ done: boolean; error: string | null; url: string | null; mailto: string | null }>(
        `/v1/messages/${o.message_id}/unsubscribe`,
        { block: false },
      );
      invalidate(qc, ["message", o.message_id], ["address", a.id]);
      if (r.done) toast(ta.unsubDone, "success");
      else if (r.url || r.mailto) {
        window.open(r.url ?? r.mailto!, "_blank", "noopener,noreferrer");
        toast(ta.unsubFinish, "success");
      } else toast(r.error ?? ta.unsubFailed, "error");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    localStorage.setItem(dismissKey(o), "1");
    rerender((n) => n + 1);
  };
  const others = (q.data?.senders ?? 1) - 1;
  return (
    <div
      data-testid="unsubscribe-banner"
      className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
    >
      <span className="min-w-0 flex-1 truncate">
        {t.newsletterFrom} <strong className="font-medium">{o.from_name || o.from || t.unknownSender}</strong>
        {o.from_name && o.from && <span className="text-zinc-500"> ({o.from})</span>}
        {others > 0 && <span className="text-zinc-500">{t.andMore(others)}</span>}
        {t.unsubscribeQ}
      </span>
      <button
        className="btn-secondary px-2 py-0.5 text-xs"
        disabled={busy}
        onClick={run}
        title={o.kind === "one_click" ? t.oneClick : t.opensPage}
      >
        {ta.unsubscribe}
      </button>
      <button
        className="px-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        onClick={dismiss}
        aria-label={t.hideSuggestion}
      >
        {t.hide}
      </button>
    </div>
  );
}
