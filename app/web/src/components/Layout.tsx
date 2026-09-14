import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../api";
import { useAuth } from "../auth";

function ThemeToggle() {
  const [pref, setPref] = useState(localStorage.getItem("theme") ?? "system");
  const apply = (v: string) => {
    localStorage.setItem("theme", v);
    setPref(v);
    const dark = v === "dark" || (v === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  };
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-500">
      <span>Theme</span>
      <select className="input w-auto py-1 text-xs" value={pref} onChange={(e) => apply(e.target.value)} aria-label="Color theme">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-500 ${
    isActive ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
  }`;

export function Layout({ children }: { children: ReactNode }) {
  const { user, cloudflareMode } = useAuth();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const logout = async () => {
    await post("/v1/auth/logout").catch(() => {});
    qc.clear();
    nav("/login");
    location.reload();
  };
  const links = (
    <nav aria-label="Main" className="flex flex-col gap-1" onClick={() => setOpen(false)}>
      <NavLink to="/" end className={linkCls}>Addresses</NavLink>
      <NavLink to="/destinations" className={linkCls}>Destinations</NavLink>
      <NavLink to="/keys" className={linkCls}>API keys</NavLink>
      <NavLink to="/account" className={linkCls}>Account</NavLink>
      {user?.role === "admin" && (
        <>
          <p className="mt-4 mb-1 px-3 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Admin</p>
          <NavLink to="/admin/domains" className={linkCls}>Domains</NavLink>
          <NavLink to="/admin/users" className={linkCls}>Users &amp; invites</NavLink>
          <NavLink to="/admin/audit" className={linkCls}>Audit log</NavLink>
        </>
      )}
      <a href="/docs" className="block rounded-md px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" target="_blank" rel="noreferrer">API docs ↗</a>
    </nav>
  );
  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 md:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <span className="font-semibold">✉ Throwaway Mail</span>
        <button className="btn-ghost" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Menu"}
        </button>
      </header>
      {open && (
        <div id="mobile-nav" className="border-b border-zinc-200 bg-white p-3 md:hidden dark:border-zinc-800 dark:bg-zinc-900">
          {links}
          <button className="btn-ghost mt-2 w-full justify-start" onClick={logout}>Log out</button>
        </div>
      )}
      <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-zinc-200 bg-white p-4 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <div className="mb-6 flex items-center gap-2 px-3 text-lg font-semibold">
            <img src="/favicon.svg" alt="" className="size-6" /> Throwaway Mail
          </div>
          {links}
        </div>
        <div className="space-y-3 px-3">
          {cloudflareMode === "mock" && <p className="badge bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">Cloudflare mock mode</p>}
          <ThemeToggle />
          <div className="truncate text-xs text-zinc-500" title={user?.email}>{user?.email}</div>
          <button className="btn-secondary w-full" onClick={logout}>Log out</button>
        </div>
      </aside>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8">
        {children}
      </main>
    </div>
  );
}
