import sanitizeHtml from "sanitize-html";

/**
 * Sanitise e-mail HTML for display. Scripts, event handlers, forms and embeds are removed.
 * Remote images are neutralised (src moved to data-blocked-src); the iframe CSP blocks the rest.
 */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img", "style", "center", "font", "span", "div", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "h1", "h2", "h3", "h4", "h5", "h6", "u", "s", "small", "big", "hr", "br",
    ]),
    allowVulnerableTags: true, // <style> is allowed; it cannot run script and remote url() is blocked by CSP
    allowedAttributes: {
      "*": ["style", "class", "align", "valign", "width", "height", "bgcolor", "color", "dir", "lang", "title", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "face", "size"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "data-blocked-src"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel", "cid", "data"],
    allowedSchemesByTag: { img: ["data", "cid"] },
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (/^(data|cid):/i.test(src)) return { tagName, attribs };
        const { src: _drop, ...rest } = attribs;
        return { tagName, attribs: { ...rest, "data-blocked-src": src, alt: attribs.alt ?? "" } };
      },
    },
  });
}
