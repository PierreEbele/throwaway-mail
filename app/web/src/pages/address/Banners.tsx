import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address } from "../../types";
import { useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { fullDate, hostOf, timeAgo } from "../../util";
import { useReplace, useSenderAction } from "./hooks";

export function ExpiryBanner({ a }: { a: Address }) {
  const qc = useQueryClient();
  const toast = useToast();
  const left = a.expires_at! - Date.now();
  if (left > 3 * 86400_000) return null;
  const extend = (days: number | null) =>
    post<{ address: Address }>(`/v1/addresses/${a.id}/extend`, { days }).then(
      (r) => {
        qc.setQueryData(["address", a.id], r.address);
        invalidate(qc, ["addresses"]);
        toast(days ? `Extended by ${days} days` : "Expiry removed", "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  const btn = "rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/50";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="flex-1">
        {left <= 0
          ? "This address has expired: new mail is rejected."
          : `This address expires ${timeAgo(a.expires_at!)} (${fullDate(a.expires_at!)}).`}
      </span>
      <button className={btn} onClick={() => extend(7)}>
        +7 days
      </button>
      <button className={btn} onClick={() => extend(30)}>
        +30 days
      </button>
      <button className={btn} onClick={() => extend(null)}>
        Never expire
      </button>
    </div>
  );
}

export function LeakBanner({ a, onPause }: { a: Address; onPause: () => void }) {
  const act = useSenderAction(a.id);
  const replace = useReplace(a);
  const btn = "rounded border border-red-300 px-2 py-0.5 hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/50";
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
    >
      <p>
        <strong>Possible leak.</strong> {timeAgo(a.leak!.at)}, this address received mail from{" "}
        <code className="font-mono">{a.leak!.sender}</code>, which is not {hostOf(a.site_url)}. The site may have sold or leaked it.
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <button
          className={`${btn} font-semibold`}
          onClick={replace}
          title="New address for this site, old one paused, site opened so you can change your e-mail"
        >
          Replace the address
        </button>
        <button className={btn} onClick={() => act.mutate({ action: "block" })}>
          Block this sender
        </button>
        {a.status === "active" && (
          <button className={btn} onClick={onPause}>
            Burn the address (reject all mail)
          </button>
        )}
        <button className={btn} onClick={() => act.mutate({ action: "trust" })}>
          It's legit, trust this sender
        </button>
        <button className={btn} onClick={() => act.mutate({ action: "dismiss" })}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
