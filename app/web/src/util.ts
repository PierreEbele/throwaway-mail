export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return "in " + timeAgo(Date.now() - (ts - Date.now())).replace(" ago", "");
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function fullDate(ts: number | null | undefined) {
  return ts ? new Date(ts).toLocaleString() : "—";
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
