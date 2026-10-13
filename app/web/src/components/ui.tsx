import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../util";

/* ---------- Toasts ---------- */
interface Toast { id: number; text: string; kind: "info" | "error" | "success" }
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md px-4 py-2 text-sm shadow-lg ${
              t.kind === "error" ? "bg-red-600 text-white" : t.kind === "success" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-white dark:bg-zinc-700"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Modal (native <dialog>: focus trap, Escape, backdrop) ---------- */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal() focuses the first focusable element (the close button); move focus to the first field instead.
      const first = d.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), select, textarea");
      first?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="modal-title"
      className={`m-auto w-[calc(100%-2rem)] ${wide ? "max-w-2xl" : "max-w-lg"} rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100`}
    >
      {open && (
        <div className="p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="modal-title" className="text-lg font-semibold">{title}</h2>
            <button className="btn-ghost -mt-1 -mr-2 px-2" onClick={onClose} aria-label="Close dialog">✕</button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/* ---------- Small pieces ---------- */
export function CopyButton({ text, label = "Copy", className = "btn-secondary", big }: { text: string; label?: string; className?: string; big?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`${className} ${big ? "px-4 py-2 text-base" : ""}`}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      aria-label={`${label}: ${text}`}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-zinc-500" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-t-zinc-100" aria-hidden />
      {label}…
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  archived: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  error: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
  verified: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  unverified: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  used: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  expired: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  admin: "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
  user: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  disabled: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
};
export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return <span className={`badge ${STATUS_STYLES[value] ?? STATUS_STYLES.archived}`}>{children ?? value}</span>;
}

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100 disabled:opacity-50 ${
        checked ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow dark:bg-zinc-900 transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-zinc-500 dark:text-zinc-400">{children}</div>}
    </div>
  );
}

export function confirmAction(message: string) {
  return window.confirm(message);
}
