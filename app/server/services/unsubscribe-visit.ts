import { decodeEntities } from "../parser/html.js";
import { readCapped, safeFetch, siteOf, type Resolver } from "../lib/outbound.js";

/** Pages confirming the unsubscription, English and French. */
const SUCCESS_RE =
  /(?:you(?:'ve| have)? (?:been |are (?:now )?)?(?:successfully )?unsubscribed|successfully unsubscribed|unsubscribe(?:d)? successful(?:ly)?|unsubscription (?:is )?(?:complete|confirmed)|(?:have|has) been (?:removed|unsubscribed) from|vous (?:êtes|avez) (?:bien )?(?:été )?(?:désabonnée?|désinscrite?)|(?:désabonnement|désinscription) (?:a été |a bien été )?(?:confirmée?|effectuée?|pris(?:e)? en compte|réussie?))/i;
/** Forms that are an unsubscribe confirmation, by their action or their content. */
const FORM_RE = /unsub|opt[-_ ]?out|d[ée]sabonn|d[ée]sinscri|confirm/i;

const MAX_REDIRECTS = 5;
const MAX_BODY = 512 * 1024;
const TOTAL_TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (compatible; ThrowawayMail unsubscribe)";

export interface VisitDeps {
  fetch: typeof fetch;
  resolve: Resolver;
}

export interface VisitResult {
  done: boolean;
  /** Why the server could not confirm it; the user should open the page. */
  error: string | null;
}

interface Page {
  url: URL;
  status: number;
  html: string;
}

/**
 * Session cookies of the visit, kept per host: a cookie set by one host is only ever sent back to that host, so a
 * redirect to another site never carries it. Never seeded with anything of the user's.
 */
export class Jar {
  private cookies = new Map<string, Map<string, string>>();
  add(host: string, res: Response) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      if (i <= 0) continue;
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (!/^[!#-'*+\-.^-z|~0-9A-Za-z]+$/.test(name) || /[\r\n;]/.test(value)) continue;
      const jar = this.cookies.get(host.toLowerCase()) ?? new Map<string, string>();
      jar.set(name, value);
      this.cookies.set(host.toLowerCase(), jar);
    }
  }
  header(host: string) {
    return [...(this.cookies.get(host.toLowerCase()) ?? [])].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Fetches `url` following redirects by hand so that every hop goes through the outbound URL check and is pinned. */
async function load(
  deps: VisitDeps,
  jar: Jar,
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  signal: AbortSignal,
): Promise<Page> {
  let current = url;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(current).hostname;
    const headers: Record<string, string> = { "user-agent": UA, accept: "text/html,*/*;q=0.5" };
    const cookie = jar.header(host);
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    const { res, url: u } = await safeFetch(deps, current, { method, headers, body, signal }, { httpsOnly: true });
    jar.add(u.hostname, res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      current = new URL(loc, u).toString();
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return { url: u, status: res.status, html: await readCapped(res, MAX_BODY) };
  }
  throw new Error("Too many redirects");
}

/** A confirmation form may only be sent to the site of the page that shows it (or of the original link). */
export function formTargetAllowed(target: string, page: URL, origin: URL): boolean {
  let t: URL;
  try {
    t = new URL(target);
  } catch {
    return false;
  }
  if (t.protocol !== "https:" || t.username || t.password) return false;
  const site = siteOf(t.hostname);
  return site === siteOf(page.hostname) || site === siteOf(origin.hostname);
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/*
 * The page is untrusted and up to MAX_BODY long, so it is scanned with plain index searches rather than
 * backtracking patterns like `<form[^>]*>[\s\S]*?<\/form>`, whose cost grows with the square of the page size when
 * tags are left unclosed. Each helper keeps the behaviour of the pattern it replaces.
 */

/** Index of the first `needle` (ASCII, any case) at or after `from`, or -1. */
function findCi(html: string, needle: string, from: number): number {
  const re = new RegExp(needle.replace(/[/]/g, "\\/"), "gi");
  re.lastIndex = from;
  return re.exec(html)?.index ?? -1;
}

/** Every `<name …>` opening tag (names given as a regex alternation), with its attributes. Stops at an unterminated tag. */
function* openTags(html: string, names: string): Generator<{ name: string; attrs: string; start: number; end: number }> {
  const re = new RegExp(`<(${names})\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const from = m.index + m[0].length;
    const gt = html.indexOf(">", from);
    if (gt < 0) return; // no later tag can be terminated either
    const end = gt + 1;
    const next = yield { name: m[1]!.toLowerCase(), attrs: html.slice(from, gt), start: m.index, end };
    re.lastIndex = typeof next === "number" ? next : end;
  }
}

/** Same as `html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")`. */
function dropRawText(html: string): string {
  const re = /<(script|style|noscript)\b/gi;
  const unclosed = new Set<string>();
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1]!.toLowerCase();
    if (unclosed.has(name)) continue;
    const close = findCi(html, `</${name}>`, m.index + m[0].length);
    if (close < 0) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(last, m.index) + " ";
    last = close + name.length + 3;
    re.lastIndex = last;
  }
  return out + html.slice(last);
}

/** Same as `html.replace(/<[^>]+>/g, " ")`. */
function dropTags(html: string): string {
  let out = "";
  let last = 0;
  for (let lt = html.indexOf("<"); lt >= 0; lt = html.indexOf("<", lt + 1)) {
    if (html[lt + 1] === ">" || lt + 1 >= html.length) continue;
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    out += html.slice(last, lt) + " ";
    last = gt + 1;
    lt = gt;
  }
  return out + html.slice(last);
}

const visibleText = (html: string) => decodeEntities(dropTags(dropRawText(html)).replace(/\s+/g, " "));

/** The `<form>` elements of a page: same as matching `/<form\b([^>]*)>([\s\S]*?)<\/form>/gi`. */
function* forms(html: string): Generator<{ open: string; inner: string }> {
  const tags = openTags(html, "form");
  for (let t = tags.next(); !t.done;) {
    const close = findCi(html, "</form>", t.value.end);
    if (close < 0) return; // no later form is closed either
    yield { open: t.value.attrs, inner: html.slice(t.value.end, close) };
    t = tags.next(close + 7);
  }
}

/** Submit candidates: same as matching `/<button\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*)>/gi`. */
function submitCandidates(inner: string): Array<{ tag: string; text: string; button: boolean }> {
  const out: Array<{ tag: string; text: string; button: boolean }> = [];
  let buttonsClosed = true;
  const tags = openTags(inner, "button|input");
  for (let t = tags.next(); !t.done;) {
    const { name, attrs, end } = t.value;
    if (name === "input") {
      out.push({ tag: attrs, text: "", button: false });
      t = tags.next();
      continue;
    }
    const close = buttonsClosed ? findCi(inner, "</button>", end) : -1;
    if (close < 0) {
      buttonsClosed = false; // an unclosed <button> is not a match; nor is any later one
      t = tags.next(t.value.start + 1);
      continue;
    }
    out.push({ tag: attrs, text: inner.slice(end, close), button: true });
    t = tags.next(close + 9);
  }
  return out;
}

export function isUnsubscribeSuccess(html: string): boolean {
  return SUCCESS_RE.test(visibleText(html));
}

/** The confirmation form of an unsubscribe page, as a request a browser would send when its button is clicked. */
export function confirmationForm(html: string, base: URL): { url: string; method: "GET" | "POST"; body: string } | null {
  for (const { open, inner } of forms(html)) {
    const action = attr(open, "action") ?? "";
    if (!FORM_RE.test(action) && !FORM_RE.test(visibleText(inner)) && !FORM_RE.test(inner)) continue;
    // A required field the user must fill (an e-mail, a reason) cannot be answered for them.
    const fields = new URLSearchParams();
    let blocked = false;
    for (const t of openTags(inner, "input|select|textarea")) {
      const tag = t.attrs;
      const name = attr(tag, "name");
      const type = (attr(tag, "type") ?? "text").toLowerCase();
      if (!name || t.name !== "input") {
        if (name && /\brequired\b/i.test(tag)) blocked = true;
        continue;
      }
      if (type === "submit" || type === "button" || type === "image" || type === "reset") continue;
      if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(tag)) continue;
      const value = attr(tag, "value") ?? (type === "checkbox" || type === "radio" ? "on" : "");
      if (!value && /\brequired\b/i.test(tag)) blocked = true;
      fields.append(name, value);
    }
    if (blocked) continue;
    // The submit button that confirms, with its name/value if it has one.
    const submits = submitCandidates(inner).filter((s) => {
      const type = (attr(s.tag, "type") ?? (s.button ? "submit" : "")).toLowerCase();
      return type === "submit" || type === "image";
    });
    const submit =
      submits.find((s) => FORM_RE.test(`${attr(s.tag, "value") ?? ""} ${visibleText(s.text)} ${attr(s.tag, "name") ?? ""}`)) ?? submits[0];
    const sname = submit ? attr(submit.tag, "name") : null;
    if (sname) fields.append(sname, attr(submit!.tag, "value") ?? "");
    let url: URL;
    try {
      url = new URL(action || base.toString(), base);
    } catch {
      continue;
    }
    const method = (attr(open, "method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET";
    if (method === "GET") {
      for (const [k, v] of fields) url.searchParams.append(k, v);
      return { url: url.toString(), method, body: "" };
    }
    return { url: url.toString(), method, body: fields.toString() };
  }
  return null;
}

/**
 * Unsubscribes the way a person would: opens the link, and if the page asks for a confirmation, submits its form.
 * Only counts as done when the page says so.
 */
export async function visitUnsubscribe(deps: VisitDeps, url: string): Promise<VisitResult> {
  const jar = new Jar();
  // One deadline for the whole visit, redirects and form submission included.
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  try {
    const origin = new URL(url);
    let page = await load(deps, jar, url, { method: "GET" }, signal);
    if (page.status >= 400) return { done: false, error: `HTTP ${page.status}` };
    if (isUnsubscribeSuccess(page.html)) return { done: true, error: null };
    const form = confirmationForm(page.html, page.url);
    if (!form) return { done: false, error: "The page needs a manual confirmation" };
    if (!formTargetAllowed(form.url, page.url, origin)) return { done: false, error: "The confirmation form points to another site" };
    page = await load(deps, jar, form.url, form.method === "POST" ? { method: "POST", body: form.body } : { method: "GET" }, signal);
    if (page.status >= 400) return { done: false, error: `HTTP ${page.status}` };
    return isUnsubscribeSuccess(page.html)
      ? { done: true, error: null }
      : { done: false, error: "The page did not confirm the unsubscription" };
  } catch (e) {
    return { done: false, error: (e as Error).message };
  }
}
