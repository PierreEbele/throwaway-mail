import { useEffect, useCallback, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../api";
import type { Address, Category, CategoryColor, SavedSearch } from "../types";
import { ErrorText, Modal, Spinner, confirmAction, useToast } from "../components/ui";
import { NewAddressDialog, useDomains } from "./Addresses";
import { AddressDetailPage, EditSiteDialog } from "./AddressDetail";
import { timeAgo } from "../util";

/* ---------- Shared data ---------- */

export const COLORS: CategoryColor[] = ["zinc", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"];
// Full class names so Tailwind keeps them.
export const DOT: Record<CategoryColor, string> = {
  zinc: "bg-zinc-400", red: "bg-red-500", orange: "bg-orange-500", amber: "bg-amber-500", green: "bg-green-500",
  teal: "bg-teal-500", blue: "bg-blue-500", indigo: "bg-indigo-500", violet: "bg-violet-500", pink: "bg-pink-500",
};
const AVATAR: Record<CategoryColor, string> = {
  zinc: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300", amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  green: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300", teal: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300", indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300", pink: "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
};

/** MIME type used when dragging an address row onto a sidebar category. */
export const ADDRESS_DRAG_TYPE = "application/x-throwaway-address";
/** MIME type used when dragging a category to reorder the sidebar. */
export const CATEGORY_DRAG_TYPE = "application/x-throwaway-category";

export function useCategories(enabled = true) {
  return useQuery({ queryKey: ["categories"], enabled, queryFn: () => get<{ categories: Category[] }>("/v1/categories").then((r) => r.categories) });
}

const STALE_DAYS = 30;
export function useStale(enabled = true) {
  return useQuery({ queryKey: ["stale"], enabled, queryFn: () => get<{ addresses: Address[] }>(`/v1/stale-addresses?days=${STALE_DAYS}`).then((r) => r.addresses) });
}

export function useSavedSearches(enabled = true) {
  return useQuery({ queryKey: ["saved-searches"], enabled, queryFn: () => get<{ searches: SavedSearch[] }>("/v1/saved-searches").then((r) => r.searches) });
}

/** Quick filters shown as chips above the list; also what a smart folder stores. */
const QUICK_FILTERS: Array<{ key: string; value: string; label: string }> = [
  { key: "unread", value: "true", label: "Unread" },
  { key: "has_code", value: "true", label: "Has code" },
  { key: "since_hours", value: "24", label: "Last 24 h" },
  { key: "leak", value: "true", label: "Leak" },
];

/** Folder from `?folder=`: inbox | pinned | archived | none | smart:<id> | <category id>. */
export function useFolder() {
  const [sp] = useSearchParams();
  return sp.get("folder") ?? "inbox";
}
export const folderHref = (folder: string) => (folder === "inbox" ? "/" : `/?folder=${encodeURIComponent(folder)}`);

export function PinIcon({ filled, className = "size-4" }: { filled?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M9 4h6l-1 5 4 3v2h-5v6l-1 1-1-1v-6H6v-2l4-3z" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- Category dialog ---------- */

export function CategoryDialog({ open, onClose, category }: { open: boolean; onClose: () => void; category?: Category | null }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState<CategoryColor>("zinc");
  const [hidden, setHidden] = useState(false);
  const [autoMatch, setAutoMatch] = useState("");
  const [retention, setRetention] = useState("");
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (open) {
      setName(category?.name ?? "");
      setColor(category?.color ?? "blue");
      setPinned(category?.pinned ?? false);
      setHidden(category?.hidden ?? false);
      setAutoMatch(category?.auto_match ?? "");
      setRetention(category?.retention_days ? String(category.retention_days) : "");
    }
  }, [open, category]);
  const done = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["addresses"] });
    onClose();
  };
  const extra = { auto_match: autoMatch.trim() || null, retention_days: retention ? Number(retention) : null };
  const save = useMutation({
    mutationFn: () => (category ? patch(`/v1/categories/${category.id}`, { name, color, pinned, hidden, ...extra }) : post("/v1/categories", { name, color, pinned, ...extra })),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => del(`/v1/categories/${category!.id}`),
    onSuccess: () => {
      toast(`Category ${category!.name} deleted`, "success");
      nav("/");
      done();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={category ? "Edit category" : "New category"}>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <label htmlFor="cat-name" className="label">Name</label>
          <input id="cat-name" className="input" required maxLength={40} placeholder="e.g. Shopping" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset>
          <legend className="label">Colour</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`size-7 rounded-full ${DOT[c]} ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 ${color === c ? "ring-2 ring-zinc-900 dark:ring-zinc-100" : ""}`}
              />
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top of the sidebar
        </label>
        <div>
          <label htmlFor="cat-auto" className="label">Auto-sort keywords</label>
          <input id="cat-auto" className="input" maxLength={500} placeholder="e.g. shop, store, amazon" value={autoMatch} onChange={(e) => setAutoMatch(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">New addresses whose site name or URL contains one of these words go into this category.</p>
        </div>
        <div>
          <label htmlFor="cat-ret" className="label">Delete mail after (days)</label>
          <input id="cat-ret" className="input" type="number" min={1} max={3650} placeholder="Server default" value={retention} onChange={(e) => setRetention(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">Only shortens the server-wide retention; leave empty to keep the default.</p>
        </div>
        {category && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hide its addresses from the Inbox
          </label>
        )}
        <ErrorText error={save.error ?? remove.error} />
        <div className="flex items-center justify-between gap-2">
          {category ? (
            <button
              type="button"
              className="btn-ghost text-red-600"
              onClick={() => confirmAction(`Delete the category ${category.name}? Its ${category.address_count} address(es) are kept, without a category.`) && remove.mutate()}
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          {category && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() =>
                confirmAction(`Pause every active address in ${category.name}? (Undo from Account → Panic button)`) &&
                post<{ affected: number }>("/v1/panic", { category_id: category.id }).then((r) => {
                  qc.invalidateQueries();
                  toast(`${r.affected} address(es) paused`, "success");
                  onClose();
                })
              }
            >
              Pause all
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={save.isPending}>{category ? "Save" : "Create"}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- Addresses that never received mail ---------- */

function StaleDialog({ open, onClose, items }: { open: boolean; onClose: () => void; items: Address[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setChecked(new Set(items.map((a) => a.id)));
  }, [open, items]);
  const act = useMutation({
    mutationFn: (action: "archive" | "delete" | "keep") => post<{ affected: number }>("/v1/stale-addresses", { action, ids: [...checked], days: STALE_DAYS }).then((r) => ({ ...r, action })),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["stale"] });
      qc.invalidateQueries({ queryKey: ["addresses"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      toast(`${r.affected} address(es) ${r.action === "keep" ? "kept" : r.action === "archive" ? "archived" : "deleted"}`, "success");
      onClose();
    },
  });
  const toggle = (id: string) => setChecked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <Modal open={open} onClose={onClose} title="Addresses that never received mail" wide>
      <p className="mb-3 text-sm text-zinc-500">
        Created more than {STALE_DAYS} days ago and still empty. Archiving rejects future mail but keeps the address; deleting frees it. Pinned addresses are never listed.
      </p>
      <ul className="max-h-80 divide-y divide-zinc-200 overflow-auto rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((a) => (
          <li key={a.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              <input type="checkbox" checked={checked.has(a.id)} onChange={() => toggle(a.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.site_name}</span>
                <span className="block truncate font-mono text-xs text-zinc-500">{a.email}</span>
              </span>
              <span className="shrink-0 text-xs text-zinc-500">created {timeAgo(a.created_at)}</span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorText error={act.error} />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" disabled={!checked.size || act.isPending} onClick={() => act.mutate("keep")} title="Stop suggesting these">Keep them</button>
        <button className="btn-secondary" disabled={!checked.size || act.isPending} onClick={() => act.mutate("archive")}>Archive {checked.size}</button>
        <button
          className="btn-danger"
          disabled={!checked.size || act.isPending}
          onClick={() => confirmAction(`Delete ${checked.size} address(es)? This cannot be undone.`) && act.mutate("delete")}
        >
          Delete {checked.size}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Address list (middle pane) ---------- */


/** Hôte du site lié à une adresse (pour son logo), ou null. */
function siteHost(a: Address): string | null {
  try {
    return a.site_url ? new URL(a.site_url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/** Logo du site (servi et mis en cache par le serveur), ou initiale colorée à défaut. */
export function SiteAvatar({ a, color, size = "size-9" }: { a: Address; color: CategoryColor; size?: string }) {
  const host = siteHost(a);
  const [failed, setFailed] = useState(false);
  if (host && !failed)
    return (
      <span className={`grid ${size} shrink-0 place-items-center overflow-hidden rounded-full border border-zinc-200 bg-white dark:border-zinc-700`} aria-hidden>
        <img src={`/v1/icons/${encodeURIComponent(host)}`} alt="" className="size-5" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-full text-sm font-semibold uppercase ${AVATAR[color]}`} aria-hidden>
      {a.site_name.trim()[0] ?? "?"}
    </span>
  );
}

type MenuItem = { label: string; onSelect: () => void; danger?: boolean; checked?: boolean; dot?: string } | "sep" | { heading: string };

/** Menu contextuel (clic droit / touche Menu / Maj+F10) sur une adresse de la liste. */
function AddressMenu({ a, x, y, categories, onClose, onEdit }: { a: Address; x: number; y: number; categories: Category[]; onClose: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["addresses"] });
    qc.invalidateQueries({ queryKey: ["address", a.id] });
    qc.invalidateQueries({ queryKey: ["messages", a.id] });
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["stale"] });
  };
  const run = (fn: () => Promise<unknown>, done?: string) => {
    onClose();
    fn().then(() => { refresh(); if (done) toast(done, "success"); }, (e: Error) => toast(e.message, "error"));
  };
  const update = (body: Record<string, unknown>, done?: string) => run(() => patch(`/v1/addresses/${a.id}`, body), done);
  const search = sp.toString() ? `?${sp.toString()}` : "";

  const items: MenuItem[] = [
    { label: "Open", onSelect: () => { onClose(); nav(`/addresses/${a.id}${search}`); } },
    { label: "Copy address", onSelect: () => run(() => navigator.clipboard.writeText(a.email), "Address copied") },
    ...(a.unread_count > 0 ? [{ label: "Mark all as read", onSelect: () => run(() => post(`/v1/addresses/${a.id}/messages/bulk`, { action: "read", scope: "inbox" })) }] : []),
    { label: a.pinned ? "Unpin" : "Pin", onSelect: () => update({ pinned: !a.pinned }) },
    { label: "Edit site…", onSelect: () => { onClose(); onEdit(); } },
    "sep",
    { heading: "Move to" },
    ...categories.map((c) => ({ label: c.name, dot: DOT[c.color], checked: a.category_id === c.id, onSelect: () => update({ category_id: c.id }, `Moved to ${c.name}`) })),
    { label: "No category", checked: !a.category_id, onSelect: () => update({ category_id: null }) },
    "sep",
    a.status === "paused"
      ? { label: "Resume (accept mail)", onSelect: () => update({ status: "active" }) }
      : { label: "Pause (reject mail)", onSelect: () => update({ status: "paused" }) },
    a.status === "archived"
      ? { label: "Unarchive", onSelect: () => update({ status: "active" }, "Address restored") }
      : { label: "Archive", onSelect: () => update({ status: "archived" }, "Address archived") },
    {
      label: "Delete…",
      danger: true,
      onSelect: () => {
        if (!confirmAction(`Delete ${a.email} and all its messages? This cannot be undone.`)) return onClose();
        run(() => del(`/v1/addresses/${a.id}`), "Address deleted");
        if (location.pathname.includes(a.id)) nav(`/${search}`);
      },
    },
  ];

  // Reste dans la fenêtre, focus sur le premier élément, fermeture sur Échap / clic ailleurs / défilement.
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
  const onKey = (e: React.KeyboardEvent) => {
    const all = [...ref.current!.querySelectorAll<HTMLElement>("[role=menuitem],[role=menuitemradio]")];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); all[all.length - 1]?.focus(); }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${a.site_name}`}
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
          <p key={i} className="px-3 pt-1 pb-0.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{it.heading}</p>
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

function AddressRow({
  a, active, category, search, onMenu, selected, onSelect, dragIds,
}: {
  a: Address; active: boolean; category?: Category; search: string; onMenu: (a: Address, x: number, y: number) => void;
  selected: boolean; onSelect: (a: Address, range: boolean) => void; dragIds: () => string[];
}) {
  const qc = useQueryClient();
  const pin = useMutation({
    mutationFn: () => patch(`/v1/addresses/${a.id}`, { pinned: !a.pinned }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["addresses"] });
      qc.invalidateQueries({ queryKey: ["address", a.id] });
      qc.invalidateQueries({ queryKey: ["stale"] });
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
          // Clavier (touche Menu / Maj+F10) : clientX/Y valent 0, on ouvre sous la ligne.
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(a, e.clientX || r.left + 48, e.clientY || r.top + r.height / 2);
        }}
        aria-label={`${a.site_name}, ${a.email}${unread ? `, ${a.unread_count} unread` : ""}`}
        className={`flex gap-3 border-l-2 px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100 ${
          selected
            ? "border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40"
            : active ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800/70" : "border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-900"
        }`}
      >
        <SiteAvatar a={a} color={category?.color ?? "zinc"} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`truncate text-sm ${unread ? "font-semibold" : "font-medium"}`}>{a.site_name}</span>
            <span className={`ml-auto shrink-0 text-xs ${unread ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-500"}`}>{timeAgo(a.last_message_at ?? a.created_at)}</span>
          </span>
          <span className="block truncate font-mono text-xs text-zinc-500">{a.email}</span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            {unread && <span className="rounded-full bg-zinc-900 px-1.5 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">{a.unread_count}</span>}
            {category && (
              <span className="inline-flex items-center gap-1">
                <span className={`size-1.5 rounded-full ${DOT[category.color]}`} />
                {category.name}
              </span>
            )}
            {a.status !== "active" && <span className="rounded border border-zinc-300 px-1 dark:border-zinc-700">{a.status}</span>}
            {a.forward_enabled && <span title="Forwarded">↪</span>}
            {a.leak && <span className="rounded bg-red-100 px-1 text-red-700 dark:bg-red-950 dark:text-red-300" title={`Mail from ${a.leak.sender}: this address may have leaked`}>leak?</span>}
            {!a.message_count && <span>no mail yet</span>}
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

function SelectionBar({
  count, categories, archived, onClear, onAction,
}: { count: number; categories: Category[]; archived: boolean; onClear: () => void; onAction: (action: string, extra?: Record<string, unknown>) => void }) {
  const btn = "rounded px-2 py-1 hover:bg-blue-100 dark:hover:bg-blue-900/50";
  return (
    <div role="toolbar" aria-label="Selected addresses" className="flex flex-wrap items-center gap-1 border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-950 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-100">
      <span className="mr-1 font-semibold">{count} selected</span>
      <label className="sr-only" htmlFor="bulk-move">Move selection to</label>
      <select
        id="bulk-move"
        className="input w-auto py-0.5 text-xs"
        value=""
        onChange={(e) => onAction("move", { category_id: e.target.value === "__none" ? null : e.target.value })}
      >
        <option value="" disabled>Move to…</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="__none">No category</option>
      </select>
      <button className={btn} onClick={() => onAction("pin")}>Pin</button>
      <button className={btn} onClick={() => onAction("unpin")}>Unpin</button>
      <button className={btn} onClick={() => onAction("read")}>Mark read</button>
      <button className={btn} onClick={() => onAction(archived ? "unarchive" : "archive")}>{archived ? "Restore" : "Archive"}</button>
      <button className={`${btn} text-red-700 dark:text-red-300`} onClick={() => onAction("delete")}>Delete</button>
      <button className={`${btn} ml-auto`} onClick={onClear} aria-label="Clear selection">✕</button>
    </div>
  );
}

function AddressList({ folder, activeId }: { folder: string; activeId?: string }) {
  const [sp] = useSearchParams();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [domain, setDomain] = useState("");
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const searches = useSavedSearches();
  const smart = folder.startsWith("smart:") ? searches.data?.find((x) => x.id === folder.slice(6)) : undefined;
  const [reviewStale, setReviewStale] = useState(false);
  const [menu, setMenu] = useState<{ a: Address; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<Address | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((a: Address, x: number, y: number) => setMenu({ a, x, y }), []);
  const categories = useCategories();
  const domains = useDomains();
  const stale = useStale(folder === "inbox");
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setFilters({});
  }, [folder]);
  const saveSearch = () => {
    const name = window.prompt("Name of the smart folder", Object.keys(filters).map((k) => QUICK_FILTERS.find((f) => f.key === k)?.label ?? k).join(" + ") || debounced);
    if (!name) return;
    const params: Record<string, string> = { ...filters };
    if (debounced) params.q = debounced;
    if (domain) params.domain = domain;
    if (byId.has(folder) || folder === "none") params.category = folder;
    post("/v1/saved-searches", { name, params }).then(
      () => { qc.invalidateQueries({ queryKey: ["saved-searches"] }); toast(`Smart folder ${name} saved`, "success"); },
      (e: Error) => toast(e.message, "error"),
    );
  };
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (smart) for (const [k, v] of Object.entries(smart.params)) p.set(k, v);
    for (const [k, v] of Object.entries(filters)) p.set(k, v);
    if (debounced) p.set("q", debounced);
    if (domain) p.set("domain", domain);
    if (folder.startsWith("smart:")) {
      /* params come from the smart folder */
    } else if (folder === "archived") p.set("status", "archived");
    else if (folder === "pinned") p.set("pinned", "true");
    else if (folder === "inbox") p.set("hide_hidden", "true");
    else p.set("category", folder);
    return p.toString();
  }, [debounced, domain, folder, filters, smart]);
  const list = useQuery({ queryKey: ["addresses", params], queryFn: () => get<{ addresses: Address[] }>(`/v1/addresses?${params}`).then((r) => r.addresses) });
  const byId = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c])), [categories.data]);
  const title =
    folder === "inbox" ? "Inbox" : folder === "pinned" ? "Pinned" : folder === "archived" ? "Archived" : folder === "none" ? "No category" : smart ? smart.name : (byId.get(folder)?.name ?? "Category");

  const pinned = (list.data ?? []).filter((a) => a.pinned && folder !== "pinned");
  const rest = (list.data ?? []).filter((a) => !a.pinned || folder === "pinned");
  const ordered = useMemo(() => [...pinned, ...rest], [pinned, rest]);

  const refresh = useCallback(() => {
    for (const k of ["addresses", "address", "categories", "stale", "messages"]) qc.invalidateQueries({ queryKey: [k] });
  }, [qc]);
  const bulk = useCallback(
    (ids: string[], action: string, extra: Record<string, unknown> = {}, done?: string) =>
      post<{ affected: number }>("/v1/addresses/bulk", { ids, action, ...extra }).then(
        (r) => { refresh(); toast(done ?? `${r.affected} address${r.affected > 1 ? "es" : ""} updated`, "success"); },
        (e: Error) => toast(e.message, "error"),
      ),
    [refresh, toast],
  );
  const onSelect = useCallback(
    (a: Address, range: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (range && anchor.current) {
          const i = ordered.findIndex((x) => x.id === anchor.current);
          const j = ordered.findIndex((x) => x.id === a.id);
          if (i >= 0 && j >= 0) for (const x of ordered.slice(Math.min(i, j), Math.max(i, j) + 1)) next.add(x.id);
        } else if (next.has(a.id)) next.delete(a.id);
        else next.add(a.id);
        return next;
      });
      if (!range) anchor.current = a.id;
    },
    [ordered],
  );
  const dragIds = useCallback(() => [...selected], [selected]);

  // Keyboard: n new, / search, j/k move, x select, 1-9 move to category N, 0 no category, p pin, a archive address, h hide this category, Esc clear selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      const targets = selected.size ? [...selected] : activeId ? [activeId] : [];
      const current = ordered.find((x) => x.id === activeId);
      const cats = categories.data ?? [];
      const go = (a?: Address) => a && nav(`/addresses/${a.id}${sp.toString() ? `?${sp}` : ""}`);
      const idx = ordered.findIndex((x) => x.id === activeId);
      if (e.key === "n") setCreating(true);
      else if (e.key === "/") document.getElementById("addr-search")?.focus();
      else if (e.key === "j") go(ordered[idx + 1] ?? ordered[0]);
      else if (e.key === "k") go(ordered[idx - 1] ?? ordered[0]);
      else if (e.key === "x" && current) onSelect(current, false);
      else if (e.key === "Escape" && selected.size) setSelected(new Set());
      else if (/^[0-9]$/.test(e.key) && targets.length) {
        const cat = e.key === "0" ? null : cats[Number(e.key) - 1];
        if (cat === undefined) return;
        void bulk(targets, "move", { category_id: cat?.id ?? null }, cat ? `Moved to ${cat.name}` : "Removed from category");
      } else if (e.key === "p" && targets.length) {
        const pin = !(current && targets.length === 1 && current.pinned);
        void bulk(targets, pin ? "pin" : "unpin", {}, pin ? "Pinned" : "Unpinned");
      } else if (e.key === "a" && targets.length) {
        void bulk(targets, folder === "archived" ? "unarchive" : "archive", {}, folder === "archived" ? "Restored" : "Archived");
        setSelected(new Set());
      } else if (e.key === "h" && byId.has(folder)) {
        const c = byId.get(folder)!;
        patch(`/v1/categories/${c.id}`, { hidden: !c.hidden }).then(() => {
          refresh();
          toast(c.hidden ? `${c.name} shown in the Inbox` : `${c.name} hidden from the Inbox`, "success");
        });
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, activeId, ordered, categories.data, nav, sp, onSelect, bulk, folder, byId, refresh, toast]);
  const search = sp.toString() ? `?${sp.toString()}` : "";
  const staleCount = stale.data?.length ?? 0;

  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-zinc-200 px-4 pt-4 pb-3 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <button className="btn-primary px-2.5 py-1 text-xs" onClick={() => setCreating(true)} title="Shortcut: n">+ New</button>
        </div>
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="addr-search">Search addresses</label>
          <input id="addr-search" type="search" className="input py-1" placeholder="Search…  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="sr-only" htmlFor="addr-domain">Filter by domain</label>
          <select id="addr-domain" className="input w-auto py-1 text-xs" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">All domains</option>
            {(domains.data ?? []).map((d) => (
              <option key={d.id} value={d.name}>{d.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Quick filters">
          {QUICK_FILTERS.map((f) => {
            const on = filters[f.key] === f.value;
            return (
              <button
                key={f.key}
                aria-pressed={on}
                onClick={() => setFilters((prev) => { const n = { ...prev }; if (on) delete n[f.key]; else n[f.key] = f.value; return n; })}
                className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}
              >
                {f.label}
              </button>
            );
          })}
          {(Object.keys(filters).length > 0 || debounced) && !smart && (
            <button className="ml-auto text-xs text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100" onClick={saveSearch}>Save as smart folder</button>
          )}
        </div>
      </div>
      {folder === "inbox" && staleCount > 0 && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="flex-1">
            {staleCount} address{staleCount > 1 ? "es" : ""} never received mail in {STALE_DAYS} days.
          </span>
          <button className="font-semibold underline" onClick={() => setReviewStale(true)}>Review</button>
        </div>
      )}
      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          categories={categories.data ?? []}
          archived={folder === "archived"}
          onClear={() => setSelected(new Set())}
          onAction={(action, extra) => {
            if (action === "delete" && !confirmAction(`Delete ${selected.size} address(es) and all their mail?`)) return;
            void bulk([...selected], action, extra);
            if (action !== "move" && action !== "pin" && action !== "unpin" && action !== "read") setSelected(new Set());
          }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading && <Spinner />}
        <ErrorText error={list.error} />
        {list.data?.length === 0 && (
          <div className="px-6 py-12 text-center text-sm text-zinc-500">
            {debounced || domain ? "No matching addresses." : folder === "inbox" ? "No addresses yet. Press n to create one." : "Nothing here."}
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <p className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Pinned</p>
            <ul aria-label="Pinned addresses">
              {pinned.map((a) => <AddressRow key={a.id} a={a} active={a.id === activeId} category={a.category_id ? byId.get(a.category_id) : undefined} search={search} onMenu={openMenu} selected={selected.has(a.id)} onSelect={onSelect} dragIds={dragIds} />)}
            </ul>
            {rest.length > 0 && <p className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Others</p>}
          </>
        )}
        <ul aria-label="Addresses">
          {rest.map((a) => <AddressRow key={a.id} a={a} active={a.id === activeId} category={a.category_id ? byId.get(a.category_id) : undefined} search={search} onMenu={openMenu} selected={selected.has(a.id)} onSelect={onSelect} dragIds={dragIds} />)}
        </ul>
      </div>
      <NewAddressDialog open={creating} onClose={() => setCreating(false)} defaultCategory={byId.has(folder) ? folder : undefined} />
      <StaleDialog open={reviewStale} onClose={() => setReviewStale(false)} items={stale.data ?? []} />
      {menu && <AddressMenu a={menu.a} x={menu.x} y={menu.y} categories={categories.data ?? []} onClose={closeMenu} onEdit={() => setEditing(menu.a)} />}
      {editing && <EditSiteDialog key={editing.id} address={editing} open onClose={() => setEditing(null)} />}
    </section>
  );
}

/* ---------- Page: list + reading pane ---------- */

export function MailboxPage() {
  const { id } = useParams();
  const folder = useFolder();
  return (
    <div className="flex h-full min-h-0">
      <div className={`h-full w-full shrink-0 border-r border-zinc-200 md:w-80 lg:w-96 dark:border-zinc-800 ${id ? "hidden md:block" : ""}`}>
        <AddressList folder={folder} activeId={id} />
      </div>
      <div className={`h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto ${id ? "" : "hidden md:block"}`}>
        {id ? (
          <div className="p-4 md:p-6">
            <AddressDetailPage key={id} />
          </div>
        ) : (
          <EmptyReader />
        )}
      </div>
    </div>
  );
}

function EmptyReader(): ReactNode {
  return (
    <div className="grid h-full place-items-center p-8 text-center text-sm text-zinc-500">
      <div>
        <svg viewBox="0 0 24 24" className="mx-auto mb-3 size-10 text-zinc-300 dark:text-zinc-700" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
        Select an address to read its mail.
        <p className="mt-1 text-xs">
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">n</kbd> new address · <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">/</kbd> search ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">j</kbd>/<kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">k</kbd> next/previous
        </p>
        <p className="mt-1 text-xs">
          Ctrl/Shift+click to select several · <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">1</kbd>–<kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">9</kbd> move to category ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">p</kbd> pin · <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">a</kbd> archive · <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">h</kbd> hide category
        </p>
      </div>
    </div>
  );
}
