import sanitizeHtml from "sanitize-html";
import { convert } from "html-to-text";

const HIDDEN_STYLE_RE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|(?:max-)?height\s*:\s*0(?:px)?\s*(?:!important)?\s*(?:;|$)|font-size\s*:\s*0(?:px)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$))/i;

/** Remove scripts, styles, head and visually hidden elements (preheaders, tracking text). */
export function stripHidden(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "head"],
    exclusiveFilter: (frame) => {
      const style = frame.attribs?.style ?? "";
      if (style && HIDDEN_STYLE_RE.test(style)) return true;
      if ("hidden" in (frame.attribs ?? {})) return true;
      return false;
    },
  });
}

const headingNoUpper = ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } }));

/** HTML -> readable plain text with links and images dropped (links are extracted separately). */
export function htmlToText(html: string): string {
  return convert(stripHidden(html), {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      ...headingNoUpper,
      { selector: "table", format: "block" },
      { selector: "tr", format: "block" },
      { selector: "td", format: "block" },
    ],
  });
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Find text fragments that are visually emphasised in the HTML (big font, bold, heading,
 * letter-spacing, monospace) and whose whole content looks like a code. Returns normalised values.
 */
export function emphasizedTokens(html: string): Set<string> {
  const out = new Set<string>();
  const clean = stripHidden(html);
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>([^<>]{3,24})<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? "";
    const inner = decodeEntities(m[3]!).replace(/\s+/g, " ").trim();
    if (!/^[A-Z0-9][A-Z0-9 -]{2,14}$/.test(inner) || !/\d|^[A-Z]{5,8}$/.test(inner)) continue;
    let emph = ["h1", "h2", "h3", "strong", "b", "code", "pre", "big", "tt", "kbd", "samp"].includes(tag);
    const style = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const s = style ? (style[2] ?? style[3] ?? "") : "";
    const fs = /font-size\s*:\s*(\d+(?:\.\d+)?)\s*(px|pt|em|rem)/i.exec(s);
    if (fs) {
      const n = parseFloat(fs[1]!);
      const px = fs[2] === "pt" ? n * 1.33 : fs[2]!.endsWith("em") ? n * 16 : n;
      if (px >= 18) emph = true;
    }
    if (/letter-spacing|monospace|courier|font-weight\s*:\s*(bold|[6-9]00)/i.test(s)) emph = true;
    // Also look at the enclosing context (parent element style) for big fonts.
    if (!emph) {
      const before = clean.slice(Math.max(0, m.index - 300), m.index);
      const lastOpen = before.lastIndexOf("<");
      const ctx = before.slice(lastOpen);
      if (/font-size\s*:\s*(2\d|3\d|4\d)px|letter-spacing|<h[1-3]|<strong|<b\b/i.test(ctx)) emph = true;
    }
    if (emph) out.add(inner.replace(/[\s-]/g, ""));
  }
  return out;
}
