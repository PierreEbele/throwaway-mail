import { useState, type DragEvent, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { patch, post } from "../api";
import { useToast } from "./ui";
import { useAuth } from "../auth";
import { useReviewCount } from "../pages/Review";
import { ADDRESS_DRAG_TYPE, CategoryDialog, DOT, PinIcon, folderHref, useCategories } from "../pages/Mailbox";
import type { Category } from "../types";

function ThemeToggle() {
  const [pref, setPref] = useState(localStorage.getItem("theme") ?? "system");
  const apply = (v: string) => {
    localStorage.setItem("theme", v);
    setPref(v);
    const dark = v === "dark" || (v === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  };
  return (
    <select className="input w-auto py-0.5 text-xs" value={pref} onChange={(e) => apply(e.target.value)} aria-label="Color theme">
      <option value="system">Auto</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}

const itemCls = (active: boolean) =>
  `group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100 ${
    active ? "bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50" : "text-zinc-600 hover:bg-zinc-200/40 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100"
  }`;
const navCls = ({ isActive }: { isActive: boolean }) => itemCls(isActive);

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const ICONS = {
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  none: "M4 7h16M4 12h16M4 17h10",
  sort: "M4 6h16M7 12h10M10 18h4",
  dest: "M4 4h16v12H5.2L4 17.2zM8 9h8M8 12h5",
  key: "M15 7a4 4 0 1 1-3.9 4.9L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 20a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 7M22 20a7 7 0 0 0-4-6.3",
  log: "M6 3h9l4 4v14H6zM9 12h7M9 16h7",
};

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

function Folder({
  to, active, icon, label, count, pinned, dimmed, onDropAddress, children,
}: { to: string; active: boolean; icon?: ReactNode; label: string; count?: number; pinned?: boolean; dimmed?: boolean; onDropAddress?: (id: string) => void; children?: ReactNode }) {
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => !!onDropAddress && e.dataTransfer.types.includes(ADDRESS_DRAG_TYPE);
  return (
    <div
      className={`group/f relative rounded-md ${over ? "ring-2 ring-zinc-900 dark:ring-zinc-100" : ""}`}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        onDropAddress!(e.dataTransfer.getData(ADDRESS_DRAG_TYPE));
      }}
    >
      <Link to={to} className={`${itemCls(active)} ${dimmed ? "opacity-50" : ""}`} aria-current={active ? "page" : undefined}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {pinned && <span className="text-zinc-400" title="Pinned"><PinIcon filled className="size-3" /></span>}
        {!!count && <span className={`text-xs tabular-nums text-zinc-500 ${children ? "group-hover/f:invisible" : ""}`}>{count}</span>}
      </Link>
      {children}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, cloudflareMode } = useAuth();
  const review = useReviewCount(!!user);
  const categories = useCategories(!!user);
  const loc = useLocation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [editing, setEditing] = useState<Category | null | undefined>(undefined);
  const toast = useToast();
  const refreshLists = () => {
    qc.invalidateQueries({ queryKey: ["addresses"] });
    qc.invalidateQueries({ queryKey: ["address"] });
    qc.invalidateQueries({ queryKey: ["categories"] });
  };
  const moveTo = (cat: Category | null) => (id: string) =>
    patch(`/v1/addresses/${id}`, { category_id: cat?.id ?? null }).then(
      () => { refreshLists(); toast(cat ? `Moved to ${cat.name}` : "Removed from its category", "success"); },
      (e: Error) => toast(e.message, "error"),
    );
  const toggleHidden = (c: Category) =>
    patch(`/v1/categories/${c.id}`, { hidden: !c.hidden }).then(refreshLists, (e: Error) => toast(e.message, "error"));
  const mailbox = loc.pathname === "/" || loc.pathname.startsWith("/addresses/");
  const folder = new URLSearchParams(loc.search).get("folder") ?? "inbox";
  const isFolder = (f: string) => mailbox && folder === f;
  const logout = async () => {
    await post("/v1/auth/logout").catch(() => {});
    qc.clear();
    nav("/login");
    location.reload();
  };
  const cats = categories.data ?? [];
  return (
    <div className="flex h-full flex-col" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="grid size-7 place-items-center rounded-md bg-zinc-900 font-mono text-sm font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">@</span>
        <span className="font-semibold tracking-tight">Throwaway Mail</span>
      </div>
      <nav aria-label="Mailbox" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        <Folder to={folderHref("inbox")} active={isFolder("inbox")} icon={<Icon d={ICONS.inbox} />} label="Inbox" />
        <Folder to={folderHref("pinned")} active={isFolder("pinned")} icon={<PinIcon />} label="Pinned" />
        {(review.data?.count ?? 0) > 0 && (
          <NavLink to="/review" className={navCls}>
            <Icon d={ICONS.sort} />
            <span className="flex-1">To sort</span>
            <span className="rounded-full bg-zinc-900 px-1.5 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">{review.data!.count}</span>
          </NavLink>
        )}
        <Folder to={folderHref("archived")} active={isFolder("archived")} icon={<Icon d={ICONS.archive} />} label="Archived" />

        <div className="flex items-center justify-between px-2.5 pt-5 pb-1">
          <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Categories</span>
          <button className="rounded px-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" onClick={() => setEditing(null)} aria-label="New category" title="New category">
            +
          </button>
        </div>
        {cats.map((c) => (
          <Folder
            key={c.id}
            to={folderHref(c.id)}
            active={isFolder(c.id)}
            icon={<span className={`mx-1 size-2 shrink-0 rounded-full ${DOT[c.color]}`} />}
            label={c.name}
            count={c.address_count}
            pinned={c.pinned}
            dimmed={c.hidden}
            onDropAddress={moveTo(c)}
          >
            <button
              className={`absolute top-1 right-7 rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-300/60 focus-visible:opacity-100 dark:hover:bg-zinc-700 ${c.hidden ? "opacity-100 group-hover/f:opacity-100" : "opacity-0 group-hover/f:opacity-100"}`}
              onClick={() => toggleHidden(c)}
              aria-pressed={c.hidden}
              aria-label={c.hidden ? `Show ${c.name} in the Inbox` : `Hide ${c.name} from the Inbox`}
              title={c.hidden ? "Hidden from the Inbox — click to show" : "Hide from the Inbox"}
            >
              <EyeIcon off={c.hidden} />
            </button>
            <button
              className="absolute top-1 right-1 rounded px-1.5 py-0.5 text-xs text-zinc-500 opacity-0 group-hover/f:opacity-100 hover:bg-zinc-300/60 focus-visible:opacity-100 dark:hover:bg-zinc-700"
              onClick={() => setEditing(c)}
              aria-label={`Edit category ${c.name}`}
            >
              ⋯
            </button>
          </Folder>
        ))}
        <Folder to={folderHref("none")} active={isFolder("none")} icon={<Icon d={ICONS.none} />} label="No category" onDropAddress={moveTo(null)} />
        {cats.length === 0 && (
          <button className="px-2.5 py-1 text-left text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => setEditing(null)}>
            Group addresses: create a category
          </button>
        )}

        <p className="px-2.5 pt-5 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Settings</p>
        <NavLink to="/destinations" className={navCls}><Icon d={ICONS.dest} /> Destinations</NavLink>
        <NavLink to="/keys" className={navCls}><Icon d={ICONS.key} /> API keys</NavLink>
        <NavLink to="/account" className={navCls}><Icon d={ICONS.user} /> Account</NavLink>
        {user?.role === "admin" && (
          <>
            <p className="px-2.5 pt-5 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Admin</p>
            <NavLink to="/admin/domains" className={navCls}><Icon d={ICONS.globe} /> Domains</NavLink>
            <NavLink to="/admin/users" className={navCls}><Icon d={ICONS.users} /> Users</NavLink>
            <NavLink to="/admin/audit" className={navCls}><Icon d={ICONS.log} /> Audit log</NavLink>
          </>
        )}
      </nav>
      <div className="space-y-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        {cloudflareMode === "mock" && <p className="text-xs text-amber-700 dark:text-amber-400">Cloudflare mock mode</p>}
        {cloudflareMode === "unconfigured" && <p className="text-xs text-red-600">Cloudflare not configured</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-zinc-500" title={user?.email}>{user?.email}</span>
          <ThemeToggle />
        </div>
        <div className="flex items-center justify-between text-xs">
          <a href="/docs" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100" target="_blank" rel="noreferrer">API docs ↗</a>
          <button className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100" onClick={logout}>Log out</button>
        </div>
      </div>
      <CategoryDialog open={editing !== undefined} category={editing} onClose={() => setEditing(undefined)} />
    </div>
  );
}

/** App shell. `bare` pages (the mailbox) fill the whole area and manage their own scrolling. */
export function Layout({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 md:hidden dark:border-zinc-800 dark:bg-zinc-950">
        <span className="font-semibold tracking-tight">Throwaway Mail</span>
        <button className="btn-ghost" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Menu"}
        </button>
      </header>
      {open && (
        <div id="mobile-nav" className="max-h-[70dvh] overflow-hidden border-b border-zinc-200 bg-zinc-50 md:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <Sidebar onNavigate={() => setOpen(false)} />
        </div>
      )}
      <aside className="hidden w-60 shrink-0 border-r border-zinc-200 bg-zinc-50 md:block dark:border-zinc-800 dark:bg-zinc-950">
        <Sidebar />
      </aside>
      <main id="main" className={`min-h-0 min-w-0 flex-1 bg-white dark:bg-zinc-900 ${bare ? "overflow-hidden" : "overflow-y-auto"}`}>
        {bare ? children : <div className="mx-auto w-full max-w-5xl p-4 md:p-8">{children}</div>}
      </main>
    </div>
  );
}
