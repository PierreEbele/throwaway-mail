import { listUnsubscribeTargets, safeMailto } from "../lib/listheaders.js";
import { decodeEntities, stripHidden } from "./html.js";
import { unwrapRedirect } from "./links.js";

/** Where an unsubscribe target was found, best first. */
export type UnsubscribeKind = "one_click" | "https" | "mailto" | "body";

export interface UnsubscribeCandidate {
  kind: UnsubscribeKind;
  /** https (or http for body links) URL, null for mailto-only candidates. */
  url: string | null;
  mailto: string | null;
  label?: string;
}

const RANK: Record<UnsubscribeKind, number> = { one_click: 0, https: 1, mailto: 2, body: 3 };

/** Unsubscribe wording, English and French (plus the usual URL spellings). */
const UNSUB_RE =
  /unsubscri|unsub\b|opt[-_ ]?out|manage[-_ ]?(?:your[-_ ]?)?(?:e?-?mail[-_ ]?)?(?:preferences|subscriptions?)|email[-_ ]?preferences|subscription[-_ ]?(?:preferences|center|centre)|d[ée]sabonn|d[ée]sinscri|g[ée]rer[-_ ](?:mes|vos|les)?[-_ ]?pr[ée]f[ée]rences|ne plus recevoir/i;

export function isUnsubscribeText(s: string): boolean {
  return UNSUB_RE.test(s);
}

function headerTargets(headers: Array<{ key: string; value: string }>) {
  const get = (k: string) => headers.find((h) => h.key.toLowerCase() === k)?.value ?? null;
  const lu = get("list-unsubscribe");
  const targets = listUnsubscribeTargets(lu);
  const url = targets.find((t) => /^https:\/\//i.test(t)) ?? null;
  const mailto = safeMailto(targets.find((t) => /^mailto:/i.test(t)));
  const oneClick = !!url && /list-unsubscribe\s*=\s*one-click/i.test(get("list-unsubscribe-post") ?? "");
  return { url, mailto, oneClick };
}

const cleanUrl = (u: string) => decodeEntities(u.trim()).replace(/[.,;:!?)\]>'"]+$/, "");

const CONTEXT_LOOKBACK = 2000;
/** Plain-text URLs examined per message (the rest of a huge body is ignored). */
const MAX_TEXT_URLS = 500;

/** Unsubscribe links found in the body (anchors, buttons, images with an unsubscribe alt, plain-text URLs). */
export function bodyUnsubscribeLinks(input: { text?: string | null; html?: string | null }): UnsubscribeCandidate[] {
  const out = new Map<string, UnsubscribeCandidate>();
  const add = (raw: string, label: string) => {
    const href = cleanUrl(raw);
    let url: string | null = null;
    let mailto: string | null = null;
    if (/^https?:\/\//i.test(href)) url = href;
    else if (/^mailto:/i.test(href)) mailto = safeMailto(href);
    else return;
    if (!url && !mailto) return;
    const unwrapped = url ? unwrapRedirect(url) : null;
    if (!isUnsubscribeText(label) && !isUnsubscribeText(href) && !(unwrapped && isUnsubscribeText(unwrapped))) return;
    const key = (url ?? mailto)!;
    if (!out.has(key)) out.set(key, { kind: "body", url, mailto, label: label || undefined });
  };

  if (input.html) {
    const html = stripHidden(input.html);
    const re = /<a\b([^>]*?)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const href = m[2] ?? m[3] ?? m[4] ?? "";
      const attrs = `${m[1]} ${m[5]}`;
      const inner = m[6]!;
      // Buttons and images: the label lives in alt / title / aria-label attributes.
      const alts = [...`${attrs} ${inner}`.matchAll(/\b(?:alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((a) => a[1] ?? a[2]);
      const text = inner.replace(/<[^>]+>/g, " ");
      const label = decodeEntities([text, ...alts].join(" "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      add(href, label);
    }
    // <form action> / <button formaction> used as unsubscribe buttons.
    const formRe = /<(?:form|button)\b[^>]*?(?:form)?action\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]{0,400}?)<\/(?:form|button)>/gi;
    while ((m = formRe.exec(html))) {
      const label = decodeEntities(m[3]!.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      add(m[1] ?? m[2] ?? "", label);
    }
  }
  if (input.text) {
    const re = /(?:https?:\/\/|mailto:)[^\s<>"'\]]+/gi;
    let m: RegExpExecArray | null;
    for (let n = 0; n < MAX_TEXT_URLS && (m = re.exec(input.text)); n++) {
      // Only a bounded look-back is examined, so long lines full of URLs stay linear.
      const win = input.text.slice(Math.max(0, m.index - CONTEXT_LOOKBACK), m.index);
      const lineStart = win.lastIndexOf("\n") + 1;
      const prevLineStart = lineStart === 0 ? 0 : win.lastIndexOf("\n", lineStart - 2) + 1;
      // Words before the URL on its line, or the line above when the URL stands alone (unless that line has its own link).
      const before = win.slice(lineStart).trim();
      const above = win.slice(prevLineStart, lineStart);
      const ctx = (before || /(?:https?:\/\/|mailto:)/i.test(above) ? before : above).replace(/\s+/g, " ").trim().slice(-120);
      add(m[0], ctx);
    }
  }
  return [...out.values()];
}

/** Every unsubscribe candidate of one message, best first. */
export function unsubscribeCandidates(input: {
  headers?: Array<{ key: string; value: string }>;
  text?: string | null;
  html?: string | null;
}): UnsubscribeCandidate[] {
  const out: UnsubscribeCandidate[] = [];
  const h = headerTargets(input.headers ?? []);
  if (h.url) out.push({ kind: h.oneClick ? "one_click" : "https", url: h.url, mailto: h.mailto });
  else if (h.mailto) out.push({ kind: "mailto", url: null, mailto: h.mailto });
  out.push(...bodyUnsubscribeLinks(input).filter((c) => c.url && c.url !== h.url));
  return pickUnsubscribe(out);
}

/** Rank candidates (one-click, https header, mailto header, body link) and drop duplicate targets. */
export function pickUnsubscribe<T extends UnsubscribeCandidate>(cands: T[]): T[] {
  const seen = new Set<string>();
  return [...cands]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => RANK[a.c.kind] - RANK[b.c.kind] || a.i - b.i)
    .map(({ c }) => c)
    .filter((c) => {
      const key = (c.url ?? c.mailto ?? "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
