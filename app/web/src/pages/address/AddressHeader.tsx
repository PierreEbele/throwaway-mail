import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { del } from "../../api";
import type { Address } from "../../types";
import { Badge, CopyButton, confirmAction, useToast } from "../../components/ui";
import { PinIcon } from "../../components/icons";
import { invalidate } from "../../queries";
import { hostOf, timeAgo } from "../../util";
import { DOT, useCategories } from "../mailbox/shared";
import { ExpiryBanner, LeakBanner } from "./Banners";

/** Title, address, actions (pin, category, pause, delete) and the status banners. */
export function AddressHeader({
  a,
  back,
  onUpdate,
  onEdit,
}: {
  a: Address;
  back: string;
  onUpdate: (body: Record<string, unknown>) => void;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const categories = useCategories();
  const remove = useMutation({
    mutationFn: () => del(`/v1/addresses/${a.id}`),
    onSuccess: () => {
      invalidate(qc, ["addresses"]);
      toast("Address deleted", "success");
      nav(back);
    },
  });
  return (
    <div>
      <Link to={back} className="text-sm text-zinc-500 hover:text-zinc-900 md:hidden dark:hover:text-zinc-100">
        ← Back
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {a.site_name} {a.status !== "active" && <Badge value={a.status} />}
          </h1>
          {a.site_url && (
            <a
              href={a.site_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100"
            >
              {hostOf(a.site_url)} ↗
            </a>
          )}
          {a.label && <p className="text-sm text-zinc-500">{a.label}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-zinc-100 px-2 py-1 font-mono text-base break-all dark:bg-zinc-800">{a.email}</code>
            <CopyButton text={a.email} label="Copy address" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={`btn-secondary px-2 ${a.pinned ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-500"}`}
            onClick={() => onUpdate({ pinned: !a.pinned })}
            aria-pressed={a.pinned}
            title={a.pinned ? "Unpin" : "Pin to the top"}
          >
            <PinIcon filled={a.pinned} /> {a.pinned ? "Pinned" : "Pin"}
          </button>
          <label className="sr-only" htmlFor="addr-category">
            Category
          </label>
          <span className="relative inline-flex items-center">
            {a.category_id && categories.data?.find((c) => c.id === a.category_id) && (
              <span
                className={`pointer-events-none absolute left-2.5 size-2 rounded-full ${DOT[categories.data.find((c) => c.id === a.category_id)!.color]}`}
              />
            )}
            <select
              id="addr-category"
              className={`input w-auto py-1.5 ${a.category_id ? "pl-6" : ""}`}
              value={a.category_id ?? ""}
              onChange={(e) => onUpdate({ category_id: e.target.value || null })}
            >
              <option value="">No category</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </span>
          <button className="btn-secondary" onClick={onEdit}>
            Edit site
          </button>
          {a.status === "active" ? (
            <button className="btn-secondary" onClick={() => onUpdate({ status: "paused" })}>
              Pause
            </button>
          ) : (
            <button className="btn-secondary" onClick={() => onUpdate({ status: "active" })}>
              {a.status === "archived" ? "Unarchive" : "Resume"}
            </button>
          )}
          {a.status !== "archived" && (
            <button className="btn-secondary" onClick={() => onUpdate({ status: "archived" })}>
              Archive
            </button>
          )}
          <button
            className="btn-danger"
            onClick={() =>
              confirmAction(`Delete ${a.email} and its ${a.message_count} message(s)? This cannot be undone.`) && remove.mutate()
            }
          >
            Delete
          </button>
        </div>
      </div>
      {a.status !== "active" && (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">This address is {a.status}: new mail is rejected.</p>
      )}
      {a.expires_at && a.status !== "archived" && <ExpiryBanner a={a} />}
      {a.burned && a.status !== "active" && (
        <p className="mt-1 text-sm text-zinc-500">
          Paused automatically {timeAgo(a.burned.at)}:{" "}
          {a.burned.reason === "after_code"
            ? "it received its verification code."
            : a.burned.reason === "max_messages"
              ? `it reached ${a.max_messages} mail(s).`
              : a.burned.reason === "expired"
                ? "it expired. Extend it to accept mail again."
                : "panic button."}
        </p>
      )}
      {a.leak && <LeakBanner a={a} onPause={() => onUpdate({ status: "paused" })} />}
    </div>
  );
}
