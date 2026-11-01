import {
  STRONG_KEYWORDS,
  WEAK_KEYWORDS,
  ORDER_CONTEXT_RE,
  PHONE_CONTEXT_RE,
  UNIT_AFTER_RE,
  UPPERCASE_STOPWORDS,
  STREET_AFTER_RE,
} from "./keywords.js";

export interface CodeCandidate {
  value: string; // normalised (separators removed)
  raw: string; // as it appeared
  score: number;
  confidence: number;
  method: "keyword" | "subject" | "html-emphasis" | "isolated" | "pattern";
  keyword?: string;
}

interface RawMatch {
  raw: string;
  value: string;
  index: number;
  kind: "digits" | "grouped" | "alnum" | "letters" | "prefixed";
}

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

export function normalizeText(t: string): string {
  return t.replace(ZERO_WIDTH, "").replace(/[   ]/g, " ").replace(/\r\n?/g, "\n");
}

/** Replace URLs and e-mail addresses with spaces (same length) so their digits never become candidates. */
function maskNoise(t: string): string {
  const blank = (s: string) => " ".repeat(s.length);
  return t
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"]+/gi, blank)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, blank)
    .replace(/\[[^\]\n]*(?:https?:|www\.)[^\]\n]*\]/gi, blank);
}

/** Spans that look like phone numbers (≥ 9 digits split by separators). */
function phoneSpans(t: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /(?:\+\d{1,3}[\s.-]?)?\(?\d{1,4}\)?(?:[\s.-]\(?\d{1,4}\)?){2,6}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9 && /[\s.()-]/.test(m[0].trim())) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function findRawMatches(t: string): RawMatch[] {
  const out: RawMatch[] = [];
  const push = (raw: string, value: string, index: number, kind: RawMatch["kind"]) => out.push({ raw, value, index, kind });
  let m: RegExpExecArray | null;

  const prefixed = /(?<![\w-])([A-Z]{1,3})-(\d{4,8})(?![\w-])/g;
  while ((m = prefixed.exec(t))) push(m[0], m[2]!, m.index, "prefixed");

  const grouped = /(?<![\w.,:\/-])(\d{3})([- ])(\d{3})(?![\w]|[- .]\d)/g;
  while ((m = grouped.exec(t))) push(m[0], m[1]! + m[3]!, m.index, "grouped");

  const groupedAlnum = /(?<![\w-])([A-Z0-9]{3})-([A-Z0-9]{3})(?![\w-])/g;
  while ((m = groupedAlnum.exec(t))) {
    if (/^\d+$/.test(m[1]! + m[2]!) || !/\d/.test(m[1]! + m[2]!)) continue;
    push(m[0], m[1]! + m[2]!, m.index, "grouped");
  }

  const digits = /(?<![\w.,\/:@#$€£+-])(\d{4,8})(?![\w%€$£]|[.,:\/-]\d)/g;
  while ((m = digits.exec(t))) push(m[1]!, m[1]!, m.index, "digits");

  const alnum = /(?<![\w-])([A-Z0-9]{5,8})(?![\w-])/g;
  while ((m = alnum.exec(t))) {
    const v = m[1]!;
    if (/^\d+$/.test(v)) continue;
    if (UPPERCASE_STOPWORDS.has(v)) continue;
    push(v, v, m.index, /\d/.test(v) ? "alnum" : "letters");
  }
  return out;
}

function findKeyword(windowText: string, list: string[], fromEnd: boolean): { kw: string; dist: number } | null {
  const lower = windowText.toLowerCase();
  let best: { kw: string; dist: number } | null = null;
  for (const kw of list) {
    const idx = fromEnd ? lower.lastIndexOf(kw) : lower.indexOf(kw);
    if (idx < 0) continue;
    // word boundary check for short keywords
    if (kw.length <= 4) {
      const before = lower[idx - 1] ?? " ";
      const after = lower[idx + kw.length] ?? " ";
      if (/[a-zà-ÿ]/.test(before) || /[a-zà-ÿ]/.test(after)) continue;
    }
    const dist = fromEnd ? lower.length - (idx + kw.length) : idx;
    if (!best || dist < best.dist) best = { kw, dist };
  }
  return best;
}

export interface CodeInput {
  subject?: string | null;
  text: string;
  emphasized?: Set<string>;
}

export function extractCodes(input: CodeInput): CodeCandidate[] {
  const text = normalizeText(input.text);
  const masked = maskNoise(text);
  const phones = phoneSpans(masked);
  const subject = normalizeText(input.subject ?? "");
  const subjectLower = subject.toLowerCase();
  const subjectHasKw = !!findKeyword(subjectLower, [...STRONG_KEYWORDS, "code", "otp", "verify", "vérif"], false);
  const emphasized = input.emphasized ?? new Set<string>();

  const byValue = new Map<string, CodeCandidate>();

  for (const rm of findRawMatches(masked)) {
    const start = rm.index;
    const end = rm.index + rm.raw.length;
    if (phones.some(([a, b]) => start >= a && end <= b && b - a > rm.raw.length)) continue;

    const before = masked.slice(Math.max(0, start - 160), start);
    const after = masked.slice(end, end + 100);
    const lineStart = masked.lastIndexOf("\n", start - 1) + 1;
    const lineEndIdx = masked.indexOf("\n", end);
    const line = masked.slice(lineStart, lineEndIdx < 0 ? masked.length : lineEndIdx);
    const lineTrim = line.trim().replace(/^[:\-–—•*>\s]+|[.\s]+$/g, "");

    // Hard rejections
    if (/[$€£¥]\s?$/.test(before) || /^\s?(?:€|eur\b|usd\b|\$|dollars?|euros?|chf\b|gbp\b)/i.test(after) || /^[.,]\d{2}\b/.test(after))
      continue;
    if (/(?:©|\(c\)|copyright)\s*$/i.test(before.slice(-15))) continue;

    let score = 0;
    let method: CodeCandidate["method"] = "pattern";
    let methodScore = 0;
    const credit = (pts: number, m: CodeCandidate["method"]) => {
      score += pts;
      if (pts > methodScore) {
        methodScore = pts;
        method = m;
      }
    };

    // Keyword proximity (before has more weight than after)
    const strongBefore = findKeyword(before, STRONG_KEYWORDS, true);
    const weakBefore = findKeyword(before, WEAK_KEYWORDS, true);
    const strongAfter = findKeyword(after, STRONG_KEYWORDS, false);
    const weakAfter = findKeyword(after, WEAK_KEYWORDS, false);
    let kwScore = 0;
    let keyword: string | undefined;
    const consider = (hit: { kw: string; dist: number } | null, max: number, range: number) => {
      if (!hit) return;
      const s = max * Math.max(0, 1 - hit.dist / range);
      if (s > kwScore) {
        kwScore = s;
        keyword = hit.kw;
      }
    };
    consider(strongBefore, 50, 160);
    consider(weakBefore, 30, 120);
    consider(strongAfter, 40, 100);
    consider(weakAfter, 20, 60);
    if (kwScore > 0) {
      const lineLower = line.toLowerCase();
      if (keyword && lineLower.includes(keyword)) kwScore += 12;
      credit(kwScore, "keyword");
    }

    // Subject hints
    if (subject.includes(rm.raw) || subject.includes(rm.value)) credit(35, "subject");
    else if (subjectHasKw) score += 8;

    // Layout hints
    if (emphasized.has(rm.value) || emphasized.has(rm.raw.replace(/[\s-]/g, ""))) credit(25, "html-emphasis");
    if (lineTrim === rm.raw) credit(18, "isolated");

    // Shape
    switch (rm.kind) {
      case "digits":
        score += rm.value.length === 6 ? 8 : rm.value.length === 4 || rm.value.length === 5 ? 3 : 2;
        break;
      case "grouped":
        score += 12;
        break;
      case "prefixed":
        score += 10;
        break;
      case "alnum":
        score += 4;
        break;
      case "letters":
        if (lineTrim !== rm.raw || kwScore === 0) continue; // all-letter tokens only when isolated next to a keyword
        score -= 8;
        break;
    }

    // Penalties
    if (rm.kind === "digits" && rm.value.length === 4) {
      const n = Number(rm.value);
      if (n >= 1900 && n <= 2099) score -= 40;
    }
    if (ORDER_CONTEXT_RE.test(before.slice(-40))) score -= 50;
    if (PHONE_CONTEXT_RE.test(before.slice(-40))) score -= 40;
    if (UNIT_AFTER_RE.test(after)) score -= 40;
    if (rm.kind === "digits" && STREET_AFTER_RE.test(after)) score -= 40;
    if (rm.value.length === 5 && rm.kind === "digits") {
      if (/^\s+[A-ZÀ-Ý][a-zà-ÿ'-]+/.test(after) || /\b[A-Z]{2}\s$/.test(before) || /^\s+cedex/i.test(after)) score -= 40;
    }
    if (/(?:€|\$|£)\s?\d*[.,]?$/.test(before.slice(-3))) score -= 50;

    const confidence = Math.max(0, Math.min(1, score / 100));
    const cand: CodeCandidate = { value: rm.value, raw: rm.raw, score, confidence: Math.round(confidence * 100) / 100, method, keyword };
    const prev = byValue.get(rm.value);
    if (!prev || prev.score < cand.score) byValue.set(rm.value, cand);
    else if (prev) prev.score += 2; // repeated occurrences are a small bonus
  }

  return [...byValue.values()].sort((a, b) => b.score - a.score);
}

export const CODE_THRESHOLD = 35;
export const ALTERNATIVE_THRESHOLD = 20;
