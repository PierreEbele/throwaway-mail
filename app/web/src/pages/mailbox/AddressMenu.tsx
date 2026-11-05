import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { del, patch, post } from "../../api";
import type { Address, Category } from "../../types";
import { confirmAction, useToast } from "../../components/ui";
import { invalidateAddress } from "../../queries";
import { DOT } from "./shared";
import { useT } from "../../i18n";

type MenuItem = { label: string; onSelect: () => void; danger?: boolean; checked?: boolean; dot?: string } | "sep" | { heading: string };

/** Context menu (right click / Menu key / Shift+F10) on an address of the list. */
export function AddressMenu({
  a,
  x,
  y,
  categories,
  onClose,
  onEdit,
}: {
  a: Address;
  x: number;
  y: number;
  categories: Category[];
  onClose: () => void;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const t = useT().menus.menu;
  const [pos, setPos] = useState({ left: x, top: y });
  const refresh = () => invalidateAddress(qc, a.id);
  const run = (fn: () => Promise<unknown>, done?: string) => {
    onClose();
    fn().then(
      () => {
        refresh();
        if (done) toast(done, "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  };
  const update = (body: Record<string, unknown>, done?: string) => run(() => patch(`/v1/addresses/${a.id}`, body), done);
  const search = sp.toString() ? `?${sp.toString()}` : "";

  const items: MenuItem[] = [
    {
      label: t.open,
      onSelect: () => {
        onClose();
        nav(`/addresses/${a.id}${search}`);
      },
    },
    { label: t.copy, onSelect: () => run(() => navigator.clipboard.writeText(a.email), t.copied) },
    ...(a.unread_count > 0
      ? [
          {
            label: t.markAllRead,
            onSelect: () => run(() => post(`/v1/addresses/${a.id}/messages/bulk`, { action: "read", scope: "inbox" })),
          },
        ]
      : []),
    { label: a.pinned ? t.unpin : t.pin, onSelect: () => update({ pinned: !a.pinned }) },
    {
      label: t.editSite,
      onSelect: () => {
        onClose();
        onEdit();
      },
    },
    "sep",
    { heading: t.moveTo },
    ...categories.map((c) => ({
      label: c.name,
      dot: DOT[c.color],
      checked: a.category_id === c.id,
      onSelect: () => update({ category_id: c.id }, t.movedTo(c.name)),
    })),
    { label: t.noCategory, checked: !a.category_id, onSelect: () => update({ category_id: null }) },
    "sep",
    a.status === "paused"
      ? { label: t.resume, onSelect: () => update({ status: "active" }) }
      : { label: t.pause, onSelect: () => update({ status: "paused" }) },
    a.status === "archived"
      ? { label: t.unarchive, onSelect: () => update({ status: "active" }, t.restored) }
      : { label: t.archive, onSelect: () => update({ status: "archived" }, t.archived) },
    {
      label: t.delete,
      danger: true,
      onSelect: () => {
        if (!confirmAction(t.confirmDelete(a.email))) return onClose();
        run(() => del(`/v1/addresses/${a.id}`), t.deleted);
        if (location.pathname.includes(a.id)) nav(`/${search}`);
      },
    },
  ];

  // Stay inside the viewport, focus the first item, close on Escape / click outside / scroll.
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, innerHeight - r.height - 4)) });
    el.querySelector<HTMLElement>("[role=menuitem],[role=menuitemradio]")?.focus();
  }, [x, y]);
  useEffect(() => {
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const blur = () => onClose();
    addEventListener("mousedown", away, true);
    addEventListener("scroll", away, true);
    addEventListener("resize", blur);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("mousedown", away, true);
      removeEventListener("scroll", away, true);
      removeEventListener("resize", blur);
      removeEventListener("blur", blur);
    };
  }, [onClose]);
  const onKey = (e: KeyboardEvent) => {
    const all = [...ref.current!.querySelectorAll<HTMLElement>("[role=menuitem],[role=menuitemradio]")];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      all[(i + 1) % all.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      all[(i - 1 + all.length) % all.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      all[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      all[all.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t.actionsFor(a.site_name)}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      style={pos}
      className="fixed z-50 max-h-[80dvh] min-w-52 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      <p className="truncate px-3 pt-1 pb-1.5 font-mono text-xs text-zinc-500">{a.email}</p>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} role="separator" className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
        ) : "heading" in it ? (
          <p key={i} className="px-3 pt-1 pb-0.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
            {it.heading}
          </p>
        ) : (
          <button
            key={i}
            type="button"
            role={it.checked !== undefined ? "menuitemradio" : "menuitem"}
            aria-checked={it.checked}
            tabIndex={-1}
            onClick={it.onSelect}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none hover:bg-zinc-100 focus:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800 ${it.danger ? "text-red-600 dark:text-red-400" : ""}`}
          >
            {it.dot !== undefined && <span className={`size-2 shrink-0 rounded-full ${it.dot}`} />}
            {it.checked === undefined && it.dot === undefined ? null : it.dot === undefined && <span className="size-2 shrink-0" />}
            <span className="flex-1 truncate">{it.label}</span>
            {it.checked && <span aria-hidden>✓</span>}
          </button>
        ),
      )}
    </div>
  );
}
