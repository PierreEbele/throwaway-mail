import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch } from "../../api";
import type { Address, Category } from "../../types";
import { PinIcon } from "../../components/icons";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { SiteAvatar } from "./SiteAvatar";
import { ADDRESS_DRAG_TYPE, DOT } from "./shared";

export function AddressRow({
  a,
  active,
  category,
  search,
  onMenu,
  selected,
  onSelect,
  dragIds,
}: {
  a: Address;
  active: boolean;
  category?: Category;
  search: string;
  onMenu: (a: Address, x: number, y: number) => void;
  selected: boolean;
  onSelect: (a: Address, range: boolean) => void;
  dragIds: () => string[];
}) {
  const qc = useQueryClient();
  const pin = useMutation({
    mutationFn: () => patch(`/v1/addresses/${a.id}`, { pinned: !a.pinned }),
    onSuccess: () => {
      invalidate(qc, ["addresses"], ["address", a.id], ["stale"]);
    },
  });
  const unread = a.unread_count > 0;
  return (
    <li className="group relative">
      <Link
        to={`/addresses/${a.id}${search}`}
        aria-current={active ? "page" : undefined}
        aria-haspopup="menu"
        draggable
        onDragStart={(e) => {
          const ids = selected ? dragIds() : [a.id];
          e.dataTransfer.setData(ADDRESS_DRAG_TYPE, JSON.stringify(ids));
          e.dataTransfer.setData("text/plain", a.email);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={(e) => {
          if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
          e.preventDefault();
          onSelect(a, e.shiftKey);
        }}
        aria-selected={selected}
        onContextMenu={(e) => {
          e.preventDefault();
          // Keyboard (Menu key / Shift+F10): clientX/Y are 0, so open it under the row.
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(a, e.clientX || r.left + 48, e.clientY || r.top + r.height / 2);
        }}
        aria-label={`${a.site_name}, ${a.email}${unread ? `, ${a.unread_count} unread` : ""}`}
        className={`flex gap-3 border-l-2 px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100 ${
          selected
            ? "border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40"
            : active
              ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800/70"
              : "border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-900"
        }`}
      >
        <SiteAvatar a={a} color={category?.color ?? "zinc"} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`truncate text-sm ${unread ? "font-semibold" : "font-medium"}`}>{a.site_name}</span>
            <span className={`ml-auto shrink-0 text-xs ${unread ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-500"}`}>
              {timeAgo(a.last_message_at ?? a.created_at)}
            </span>
          </span>
          <span className="block truncate font-mono text-xs text-zinc-500">{a.email}</span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            {unread && (
              <span className="rounded-full bg-zinc-900 px-1.5 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                {a.unread_count}
              </span>
            )}
            {category && (
              <span className="inline-flex items-center gap-1">
                <span className={`size-1.5 rounded-full ${DOT[category.color]}`} />
                {category.name}
              </span>
            )}
            {a.status !== "active" && (
              <span className="rounded border border-zinc-300 px-1 dark:border-zinc-700">
                {a.burned?.reason === "expired" ? "expired" : a.burned?.reason === "max_messages" ? "quota reached" : a.status}
              </span>
            )}
            {a.status === "active" && (a.expires_at || a.max_messages) && (
              <span
                title={[
                  a.expires_at ? `Expires ${new Date(a.expires_at).toLocaleString()}` : "",
                  a.max_messages ? `${a.message_count}/${a.max_messages} mail(s)` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                ⏳{a.max_messages ? ` ${a.message_count}/${a.max_messages}` : ""}
              </span>
            )}
            {a.forward_enabled && <span title="Forwarded">↪</span>}
            {a.leak && (
              <span
                className="rounded bg-red-100 px-1 text-red-700 dark:bg-red-950 dark:text-red-300"
                title={`Mail from ${a.leak.sender}: this address may have leaked`}
              >
                leak?
              </span>
            )}
            {a.no_mail_warning ? (
              <span
                className="rounded bg-amber-100 px-1 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                title="Did the site send the code? It may reject this domain."
              >
                no mail yet?
              </span>
            ) : (
              !a.message_count && <span>no mail yet</span>
            )}
          </span>
        </span>
      </Link>
      <button
        type="button"
        onClick={() => pin.mutate()}
        aria-label={a.pinned ? `Unpin ${a.site_name}` : `Pin ${a.site_name}`}
        aria-pressed={a.pinned}
        className={`absolute top-9 right-3 rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:opacity-100 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 ${
          a.pinned ? "opacity-100 text-zinc-900 dark:text-zinc-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <PinIcon filled={a.pinned} />
      </button>
    </li>
  );
}
