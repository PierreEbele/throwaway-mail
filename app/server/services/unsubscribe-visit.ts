import { decodeEntities } from "../parser/html.js";
import { checkOutboundUrl, type Resolver } from "../lib/outbound.js";

/** Pages confirming the unsubscription, English and French. */
const SUCCESS_RE =
  /(?:you(?:'ve| have)? (?:been |are (?:now )?)?(?:successfully )?unsubscribed|successfully unsubscribed|unsubscribe(?:d)? successful(?:ly)?|unsubscription (?:is )?(?:complete|confirmed)|(?:have|has) been (?:removed|unsubscribed) from|vous (?:êtes|avez) (?:bien )?(?:été )?(?:désabonnée?|désinscrite?)|(?:désabonnement|désinscription) (?:a été |a bien été )?(?:confirmée?|effectuée?|pris(?:e)? en compte|réussie?))/i;
/** Forms that are an unsubscribe confirmation, by their action or their content. */
const FORM_RE = /unsub|opt[-_ ]?out|d[ée]sabonn|d[ée]sinscri|confirm/i;

const MAX_REDIRECTS = 5;
const MAX_BODY = 512 * 1024;
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

class Jar {
  private cookies = new Map<string, string>();
  add(res: Response) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Fetches `url` following redirects by hand so that every hop goes through the outbound URL check. */
async function load(deps: VisitDeps, jar: Jar, url: string, init: { method: "GET" | "POST"; body?: string }): Promise<Page> {
  let current = url;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await checkOutboundUrl(current, { resolve: deps.resolve, httpsOnly: true });
    const headers: Record<string, string> = { "user-agent": UA, accept: "text/html,*/*;q=0.5" };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await deps.fetch(u.toString(), { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    jar.add(res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, u).toString();
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    const text = (await res.text()).slice(0, MAX_BODY);
    return { url: u, status: res.status, html: text };
  }
  throw new Error("Too many redirects");
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
};

const visibleText = (html: string) =>
  decodeEntities(
    html
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );

export function isUnsubscribeSuccess(html: string): boolean {
  return SUCCESS_RE.test(visibleText(html));
}

/** The confirmation form of an unsubscribe page, as a request a browser would send when its button is clicked. */
export function confirmationForm(html: string, base: URL): { url: string; method: "GET" | "POST"; body: string } | null {
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [, open, inner] = m;
    const action = attr(open!, "action") ?? "";
    if (!FORM_RE.test(action) && !FORM_RE.test(visibleText(inner!)) && !FORM_RE.test(inner!)) continue;
    // A required field the user must fill (an e-mail, a reason) cannot be answered for them.
    const fields = new URLSearchParams();
    let blocked = false;
    for (const t of inner!.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const tag = t[2]!;
      const name = attr(tag, "name");
      const type = (attr(tag, "type") ?? "text").toLowerCase();
      if (!name || t[1]!.toLowerCase() !== "input") {
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
    const submits = [...inner!.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*)>/gi)]
      .map((s) => ({ tag: s[1] ?? s[3]!, text: s[2] ?? "", button: s[1] !== undefined }))
      .filter((s) => {
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
    const method = (attr(open!, "method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET";
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
  try {
    let page = await load(deps, jar, url, { method: "GET" });
    if (page.status >= 400) return { done: false, error: `HTTP ${page.status}` };
    if (isUnsubscribeSuccess(page.html)) return { done: true, error: null };
    const form = confirmationForm(page.html, page.url);
    if (!form) return { done: false, error: "The page needs a manual confirmation" };
    page = await load(deps, jar, form.url, form.method === "POST" ? { method: "POST", body: form.body } : { method: "GET" });
    if (page.status >= 400) return { done: false, error: `HTTP ${page.status}` };
    return isUnsubscribeSuccess(page.html)
      ? { done: true, error: null }
      : { done: false, error: "The page did not confirm the unsubscription" };
  } catch (e) {
    return { done: false, error: (e as Error).message };
  }
}
