import { getLang, msg } from "./i18n";

const rtf = () => new Intl.RelativeTimeFormat(getLang(), { numeric: "auto", style: "short" });

/** Relative time ("5 min ago", "il y a 5 min"), or a date beyond 30 days. */
export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return msg().common.never;
  const diff = Math.round((ts - Date.now()) / 1000);
  const s = Math.abs(diff);
  const sign = diff < 0 ? -1 : 1;
  if (s < 45) return msg().common.justNow;
  const m = Math.round(s / 60);
  if (m < 60) return rtf().format(sign * m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf().format(sign * h, "hour");
  const d = Math.round(h / 24);
  if (d < 30) return rtf().format(sign * d, "day");
  return formatDate(ts);
}

export function fullDate(ts: number | null | undefined) {
  return ts ? new Intl.DateTimeFormat(getLang(), { dateStyle: "medium", timeStyle: "short" }).format(ts) : "—";
}

export function formatDate(ts: number) {
  return new Intl.DateTimeFormat(getLang(), { dateStyle: "medium" }).format(ts);
}

export function formatTime(ts: number) {
  return new Intl.DateTimeFormat(getLang(), { hour: "2-digit", minute: "2-digit" }).format(ts);
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(getLang(), opts).format(n);
}

/** Size in KB / MB with the locale's separators. */
export function formatBytes(n: number) {
  return n < 1048576
    ? formatNumber(Math.round(n / 1024), { style: "unit", unit: "kilobyte" })
    : formatNumber(n / 1048576, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/**
 * Host of a URL, or null when there is none.
 * Default: `host` as written, falling back to the raw string when it does not parse.
 * `bare`: hostname without a leading "www.", or null when it does not parse (used for site logos).
 */
export function hostOf(url: string | null, opts: { bare?: boolean } = {}) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return opts.bare ? u.hostname.replace(/^www\./, "") : u.host;
  } catch {
    return opts.bare ? null : url;
  }
}

/** localStorage flag enabling desktop notifications for new mail. */
export const NOTIFY_KEY = "notify-new-mail";
