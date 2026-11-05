import { decodeEntities, stripHidden } from "./html.js";

export interface LinkCandidate {
  url: string;
  original?: string; // tracking URL it was unwrapped from
  label?: string;
  score: number;
  confidence: number;
  method: "anchor" | "text";
}

const REDIRECT_PARAMS = [
  "url",
  "u",
  "q",
  "redirect",
  "redirect_url",
  "redirect_uri",
  "redirectUrl",
  "target",
  "dest",
  "destination",
  "link",
  "r",
  "to",
  "goto",
  "next",
];

/** Unwrap obvious tracking redirects (param holding a full http(s) URL). */
export function unwrapRedirect(url: string, depth = 0): string {
  if (depth > 3) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  for (const p of REDIRECT_PARAMS) {
    const v = u.searchParams.get(p);
    if (v && /^https?:\/\//i.test(v)) {
      try {
        new URL(v);
        return unwrapRedirect(v, depth + 1);
      } catch {
        /* ignore */
      }
    }
  }
  return url;
}

const STRONG =
  /verif|confirm|activat|validat|magic|valider|confirmer|activer|vérif|v[ée]rifier|best[äa]tig|aktivier|verifizier|verific|confirma|conferm|activa|attiva/i;
const MEDIUM =
  /sign[-_ ]?in|log[-_ ]?in|signin|login|auth|reset|password|passwort|mot-de-passe|connexion|anmeld|einloggen|iniciar|acceso|accedi|accesso|contrase|onboard|invite|accept/i;
const TOKEN_PARAM = /[?&#](?:token|code|key|t|otp|ticket|hash|sig|signature|nonce|k)=[^&]{8,}/i;
const LONG_TOKEN_PATH = /\/[A-Za-z0-9_-]{24,}(?:\/|$|\?)/;
const NEGATIVE =
  /unsubscribe|d[ée]sinscri|d[ée]sabonn|optout|opt-out|privacy|confidentialit|\/terms|conditions|\/legal|\/help|support\.|\/support|aide|preferences|abmelden|abbestellen|\/baja|darse-de-baja|disiscri|cancellati|pr[ée]f[ée]rences|facebook\.com|twitter\.com|x\.com\/|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|apps\.apple\.com|play\.google\.com|\.(?:png|jpe?g|gif|svg|webp)(?:\?|$)/i;

function scoreLink(url: string, label: string): number {
  if (
    NEGATIVE.test(url) ||
    /unsubscribe|d[ée]sabonner|se d[ée]sinscrire|abmelden|abbestellen|darse de baja|annulla iscrizione|disiscriviti/i.test(label)
  )
    return -100;
  let s = 0;
  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname + u.search + u.hash;
  } catch {
    /* keep */
  }
  if (STRONG.test(path)) s += 50;
  else if (MEDIUM.test(path)) s += 25;
  if (TOKEN_PARAM.test(url)) s += 20;
  else if (LONG_TOKEN_PATH.test(path)) s += 12;
  if (STRONG.test(label)) s += 40;
  else if (MEDIUM.test(label)) s += 12;
  return s;
}

function cleanUrl(u: string): string {
  return decodeEntities(u.trim()).replace(/[.,;:!?)\]>'"]+$/, "");
}

export function extractLinks(input: { text?: string | null; html?: string | null }): LinkCandidate[] {
  const found = new Map<string, LinkCandidate>();
  const add = (rawUrl: string, label: string, method: LinkCandidate["method"]) => {
    const original = cleanUrl(rawUrl);
    if (!/^https?:\/\//i.test(original)) return;
    const url = unwrapRedirect(original);
    const score = Math.max(scoreLink(url, label), scoreLink(original, label) - 10);
    if (score < 40) return;
    const cand: LinkCandidate = {
      url,
      original: url !== original ? original : undefined,
      label: label || undefined,
      score,
      confidence: Math.round(Math.min(1, score / 100) * 100) / 100,
      method,
    };
    const prev = found.get(url);
    if (!prev || prev.score < score || (!prev.label && label))
      found.set(url, prev && prev.score > score ? { ...prev, label: prev.label ?? cand.label } : cand);
  };

  if (input.html) {
    const html = stripHidden(input.html);
    const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const href = m[1] ?? m[2] ?? m[3] ?? "";
      const label = decodeEntities(m[4]!.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      add(href, label, "anchor");
    }
  }
  if (input.text) {
    const re = /https?:\/\/[^\s<>"'\]]+/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.text))) {
      const lineStart = input.text.lastIndexOf("\n", m.index - 1) + 1;
      const prevLineStart = input.text.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
      const ctx = input.text.slice(prevLineStart, m.index).replace(/\s+/g, " ").trim().slice(-120);
      add(m[0], ctx, "text");
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}
