import sanitizeHtml from "sanitize-html";
import { cleanLink, isTrackerHost, isTrackingPixel } from "./trackers.js";

export interface SanitizeResult {
  html: string;
  /** Tracking pixels removed + links stripped of tracking parameters. */
  trackers: number;
}

/**
 * Sanitise e-mail HTML for display. Scripts, event handlers, forms and embeds are removed.
 * Remote images are neutralised (src moved to data-blocked-src); the iframe CSP blocks the rest.
 */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeEmail(html).html;
}

/** Same as sanitizeEmailHtml, also removing open-tracking pixels and click-tracking parameters. */
export function sanitizeEmail(html: string): SanitizeResult {
  let trackers = 0;
  const out = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "style",
      "center",
      "font",
      "span",
      "div",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "colgroup",
      "col",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "u",
      "s",
      "small",
      "big",
      "hr",
      "br",
    ]),
    allowVulnerableTags: true, // <style> is allowed; it cannot run script and remote url() is blocked by CSP
    nonTextTags: ["script", "textarea", "option", "noscript", "title", "head"],
    allowedAttributes: {
      "*": [
        "style",
        "class",
        "align",
        "valign",
        "width",
        "height",
        "bgcolor",
        "color",
        "dir",
        "lang",
        "title",
        "border",
        "cellpadding",
        "cellspacing",
        "colspan",
        "rowspan",
        "face",
        "size",
      ],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "data-blocked-src"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel", "cid", "data"],
    allowedSchemesByTag: { img: ["data", "cid"] },
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ? cleanLink(attribs.href) : null;
        if (href?.changed) trackers++;
        const tracked = !!attribs.href && isTrackerHost(safeHost(attribs.href));
        return {
          tagName,
          attribs: {
            ...attribs,
            ...(href ? { href: href.url } : {}),
            ...(tracked
              ? { title: `${attribs.title ? attribs.title + " — " : ""}Tracked link (goes through ${safeHost(attribs.href!)})` }
              : {}),
            target: "_blank",
            rel: "noopener noreferrer nofollow",
          },
        };
      },
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (isTrackingPixel(attribs)) {
          trackers++;
          return { tagName: "span", attribs: {} };
        }
        if (/^(data|cid):/i.test(src)) return { tagName, attribs };
        const { src: _drop, ...rest } = attribs;
        return { tagName, attribs: { ...rest, "data-blocked-src": src, alt: attribs.alt ?? "" } };
      },
    },
  });
  return { html: out, trackers };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
