import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, patch, post } from "../../api";
import type { Address } from "../../types";
import { ErrorText, Spinner, confirmAction, useToast } from "../../components/ui";
import { invalidate, invalidateMailbox } from "../../queries";
import { NewAddressDialog, useDomains } from "../Addresses";
import { EditSiteDialog } from "../address/EditSiteDialog";
import { AddressMenu } from "./AddressMenu";
import { AddressRow } from "./AddressRow";
import { SelectionBar } from "./SelectionBar";
import { StaleDialog } from "./StaleDialog";
import { QUICK_FILTERS, STALE_DAYS, useCategories, useSavedSearches, useStale } from "./shared";
import { useT } from "../../i18n";

/** Middle pane: the addresses of a folder. */
export function AddressList({ folder, activeId }: { folder: string; activeId?: string }) {
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
  const t = useT().mailbox;
  const tn = useT().common.nav;
  const anchor = useRef<string | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setFilters({});
  }, [folder]);
  const saveSearch = () => {
    const name = window.prompt(
      t.smartName,
      Object.keys(filters)
        .map((k) => QUICK_FILTERS.find((f) => f.key === k)?.label ?? k)
        .join(" + ") || debounced,
    );
    if (!name) return;
    const params: Record<string, string> = { ...filters };
    if (debounced) params.q = debounced;
    if (domain) params.domain = domain;
    if (byId.has(folder) || folder === "none") params.category = folder;
    post("/v1/saved-searches", { name, params }).then(
      () => {
        invalidate(qc, ["saved-searches"]);
        toast(t.smartSaved(name), "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  };
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(timer);
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
  const list = useQuery({
    queryKey: ["addresses", params],
    queryFn: () => get<{ addresses: Address[] }>(`/v1/addresses?${params}`).then((r) => r.addresses),
  });
  const byId = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c])), [categories.data]);
  const title =
    folder === "inbox"
      ? tn.inbox
      : folder === "pinned"
        ? tn.pinned
        : folder === "archived"
          ? tn.archived
          : folder === "none"
            ? tn.noCategory
            : smart
              ? smart.name
              : (byId.get(folder)?.name ?? t.category);

  const pinned = (list.data ?? []).filter((a) => a.pinned && folder !== "pinned");
  const rest = (list.data ?? []).filter((a) => !a.pinned || folder === "pinned");
  const ordered = useMemo(() => [...pinned, ...rest], [pinned, rest]);

  const refresh = useCallback(() => invalidateMailbox(qc), [qc]);
  const bulk = useCallback(
    (ids: string[], action: string, extra: Record<string, unknown> = {}, done?: string) =>
      post<{ affected: number }>("/v1/addresses/bulk", { ids, action, ...extra }).then(
        (r) => {
          refresh();
          toast(done ?? t.updated(r.affected), "success");
        },
        (e: Error) => toast(e.message, "error"),
      ),
    [refresh, toast, t],
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
        void bulk(targets, "move", { category_id: cat?.id ?? null }, cat ? t.movedTo(cat.name) : t.removedFromCategory);
      } else if (e.key === "p" && targets.length) {
        const pin = !(current && targets.length === 1 && current.pinned);
        void bulk(targets, pin ? "pin" : "unpin", {}, pin ? t.pinned : t.unpinned);
      } else if (e.key === "a" && targets.length) {
        void bulk(targets, folder === "archived" ? "unarchive" : "archive", {}, folder === "archived" ? t.restored : t.archived);
        setSelected(new Set());
      } else if (e.key === "h" && byId.has(folder)) {
        const c = byId.get(folder)!;
        patch(`/v1/categories/${c.id}`, { hidden: !c.hidden }).then(() => {
          refresh();
          toast(c.hidden ? t.shownInInbox(c.name) : t.hiddenFromInbox(c.name), "success");
        });
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, activeId, ordered, categories.data, nav, sp, onSelect, bulk, folder, byId, refresh, toast, t]);
  const search = sp.toString() ? `?${sp.toString()}` : "";
  const staleCount = stale.data?.length ?? 0;

  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-zinc-200 px-4 pt-4 pb-3 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <button className="btn-primary px-2.5 py-1 text-xs" onClick={() => setCreating(true)} title={t.shortcutN}>
            {t.newBtn}
          </button>
        </div>
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="addr-search">
            {t.searchLabel}
          </label>
          <input
            id="addr-search"
            type="search"
            className="input py-1"
            placeholder={t.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="sr-only" htmlFor="addr-domain">
            {t.filterDomain}
          </label>
          <select id="addr-domain" className="input w-auto py-1 text-xs" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">{t.allDomains}</option>
            {(domains.data ?? []).map((d) => (
              <option key={d.id} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t.quickFilters}>
          {QUICK_FILTERS.map((f) => {
            const on = filters[f.key] === f.value;
            return (
              <button
                key={f.key}
                aria-pressed={on}
                onClick={() =>
                  setFilters((prev) => {
                    const n = { ...prev };
                    if (on) delete n[f.key];
                    else n[f.key] = f.value;
                    return n;
                  })
                }
                className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}
              >
                {f.label}
              </button>
            );
          })}
          {(Object.keys(filters).length > 0 || debounced) && !smart && (
            <button className="ml-auto text-xs text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100" onClick={saveSearch}>
              {t.saveSmart}
            </button>
          )}
        </div>
      </div>
      {folder === "inbox" && staleCount > 0 && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="flex-1">{t.staleBanner(staleCount, STALE_DAYS)}</span>
          <button className="font-semibold underline" onClick={() => setReviewStale(true)}>
            {t.review}
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          categories={categories.data ?? []}
          archived={folder === "archived"}
          onClear={() => setSelected(new Set())}
          onAction={(action, extra) => {
            if (action === "delete" && !confirmAction(t.confirmBulkDelete(selected.size))) return;
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
            {debounced || domain ? t.noMatch : folder === "inbox" ? t.noAddresses : t.nothing}
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <p className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{tn.pinned}</p>
            <ul aria-label={t.pinnedAddresses}>
              {pinned.map((a) => (
                <AddressRow
                  key={a.id}
                  a={a}
                  active={a.id === activeId}
                  category={a.category_id ? byId.get(a.category_id) : undefined}
                  search={search}
                  onMenu={openMenu}
                  selected={selected.has(a.id)}
                  onSelect={onSelect}
                  dragIds={dragIds}
                />
              ))}
            </ul>
            {rest.length > 0 && (
              <p className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{t.others}</p>
            )}
          </>
        )}
        <ul aria-label={t.addresses}>
          {rest.map((a) => (
            <AddressRow
              key={a.id}
              a={a}
              active={a.id === activeId}
              category={a.category_id ? byId.get(a.category_id) : undefined}
              search={search}
              onMenu={openMenu}
              selected={selected.has(a.id)}
              onSelect={onSelect}
              dragIds={dragIds}
            />
          ))}
        </ul>
      </div>
      <NewAddressDialog open={creating} onClose={() => setCreating(false)} defaultCategory={byId.has(folder) ? folder : undefined} />
      <StaleDialog open={reviewStale} onClose={() => setReviewStale(false)} items={stale.data ?? []} />
      {menu && (
        <AddressMenu
          a={menu.a}
          x={menu.x}
          y={menu.y}
          categories={categories.data ?? []}
          onClose={closeMenu}
          onEdit={() => setEditing(menu.a)}
        />
      )}
      {editing && <EditSiteDialog key={editing.id} address={editing} open onClose={() => setEditing(null)} />}
    </section>
  );
}
