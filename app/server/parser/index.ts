import { htmlToText, emphasizedTokens } from "./html.js";
import { extractCodes, CODE_THRESHOLD, ALTERNATIVE_THRESHOLD, type CodeCandidate } from "./codes.js";
import { extractLinks, type LinkCandidate } from "./links.js";

export { htmlToText, stripHidden } from "./html.js";
export { extractCodes } from "./codes.js";
export { extractLinks, unwrapRedirect } from "./links.js";

export interface ParseInput {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}

export interface ParsedCode {
  value: string;
  raw: string;
  confidence: number;
  method: string;
}

export interface ParseResult {
  code: ParsedCode | null;
  alternatives: ParsedCode[];
  links: Array<{ url: string; original?: string; label?: string; confidence: number; method: string }>;
  strategy: string;
}

/** The text actually analysed: text part when it has content, otherwise HTML converted to text. */
export function bodyText(input: ParseInput): string {
  const text = (input.text ?? "").trim();
  if (text.length > 0) return input.text!;
  if (input.html) return htmlToText(input.html);
  return "";
}

const toParsed = (c: CodeCandidate): ParsedCode => ({ value: c.value, raw: c.raw, confidence: c.confidence, method: c.method });
const toLink = (l: LinkCandidate) => ({ url: l.url, original: l.original, label: l.label, confidence: l.confidence, method: l.method });

/** Only this much of the text and HTML bodies is analysed: codes and links sit near the top of a mail. */
export const MAX_PARSE_CHARS = 256 * 1024;

/** The input cut to the analysis budget. */
export function boundedInput<T extends ParseInput>(input: T): T {
  const cut = (s: string | null | undefined) => (s && s.length > MAX_PARSE_CHARS ? s.slice(0, MAX_PARSE_CHARS) : s);
  return { ...input, text: cut(input.text), html: cut(input.html) };
}

/** Deterministic, pure parser. */
export function parseMessage(full: ParseInput): ParseResult {
  const input = boundedInput(full);
  let text = bodyText(input);
  const emphasized = input.html ? emphasizedTokens(input.html) : new Set<string>();
  let candidates = extractCodes({ subject: input.subject, text, emphasized });
  // If the text part gave nothing usable but HTML exists, try the HTML rendition too.
  if ((!candidates[0] || candidates[0].score < CODE_THRESHOLD) && input.html && (input.text ?? "").trim()) {
    text = htmlToText(input.html);
    const fromHtml = extractCodes({ subject: input.subject, text, emphasized });
    if (fromHtml[0] && (!candidates[0] || fromHtml[0].score > candidates[0].score)) candidates = fromHtml;
  }
  const best = candidates[0] && candidates[0].score >= CODE_THRESHOLD ? candidates[0] : null;
  const alternatives = candidates.filter((c) => c !== best && c.score >= ALTERNATIVE_THRESHOLD).slice(0, 4);
  const links = extractLinks({ text: input.text ?? (input.html ? null : text), html: input.html }).slice(0, 5);
  return {
    code: best ? toParsed(best) : null,
    alternatives: alternatives.map(toParsed),
    links: links.map(toLink),
    strategy: "deterministic",
  };
}

/** Pluggable strategy (e.g. LLM fallback). Called only when the deterministic parser found no code. */
export interface ParserStrategy {
  readonly name: string;
  extract(input: ParseInput, base: ParseResult): Promise<ParseResult | null>;
}

/** Stub for a future LLM fallback. Disabled by default (PARSER_LLM_FALLBACK=1 enables the hook, which still returns null). */
export class LlmFallbackStrategy implements ParserStrategy {
  readonly name = "llm-fallback";
  async extract(_input: ParseInput, _base: ParseResult): Promise<ParseResult | null> {
    return null;
  }
}

export async function runParser(input: ParseInput, strategies: ParserStrategy[] = []): Promise<ParseResult> {
  const base = parseMessage(input);
  if (base.code) return base;
  for (const s of strategies) {
    try {
      const r = await s.extract(input, base);
      if (r?.code) return { ...r, strategy: s.name };
    } catch {
      /* a failing optional strategy never breaks ingest */
    }
  }
  return base;
}
