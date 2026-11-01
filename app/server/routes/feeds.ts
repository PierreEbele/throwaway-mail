import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { addresses, domains, extractedItems, messages } from "../db/schema.js";
import { randomString } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";
import { addressOut, itemsOut } from "../services/serialize.js";
import { ownedAddress } from "../services/addresses.js";

const esc = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!);

export function registerFeeds(r: ApiRouter) {
  r.add(
    {
      method: "post",
      path: "/v1/addresses/:id/feed",
      summary: "Enable, rotate or disable the address's private RSS / JSON feed",
      description: "The feed URLs contain a secret token: anyone with the URL can read this address's mail.",
      tags: ["addresses"],
      auth: "user",
      body: z.object({ enabled: z.boolean() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      const { a, domain } = ownedAddress(d, user, c.req.param("id")!);
      d.db
        .update(addresses)
        .set({ feedToken: body.enabled ? randomString(32).toLowerCase() : null })
        .where(eq(addresses.id, a.id))
        .run();
      return c.json({ address: addressOut(d.db.select().from(addresses).where(eq(addresses.id, a.id)).get()!, domain) });
    },
  );

  r.add(
    {
      method: "get",
      path: "/feeds/:file",
      summary: "Private feed of an address (<token>.rss or <token>.json)",
      tags: ["addresses"],
      auth: "none",
    },
    (c) => {
      const d = c.get("deps");
      const m = /^([a-z0-9]{32})\.(rss|json)$/.exec(c.req.param("file")!);
      if (!m) throw notFound("Feed");
      const row = d.db
        .select({ a: addresses, domain: domains.name })
        .from(addresses)
        .innerJoin(domains, eq(domains.id, addresses.domainId))
        .where(eq(addresses.feedToken, m[1]!))
        .get();
      if (!row) throw notFound("Feed");
      const { a, domain } = row;
      const msgs = d.db
        .select()
        .from(messages)
        .where(and(eq(messages.addressId, a.id), isNull(messages.archivedAt)))
        .orderBy(desc(messages.receivedAt))
        .limit(50)
        .all();
      const items = msgs.length
        ? d.db
            .select()
            .from(extractedItems)
            .where(
              inArray(
                extractedItems.messageId,
                msgs.map((x) => x.id),
              ),
            )
            .all()
        : [];
      const base = d.config.APP_URL.replace(/\/$/, "");
      const entries = msgs.map((x) => {
        const ex = itemsOut(items.filter((i) => i.messageId === x.id));
        return {
          id: x.id,
          title: `${ex.code ? `[${ex.code.value}] ` : ""}${x.subject ?? "(no subject)"}`,
          from: x.fromAddr,
          received_at: x.receivedAt,
          code: ex.code?.value ?? null,
          links: ex.links.map((l) => l.url),
          text: (x.text ?? "").slice(0, 4000),
          url: `${base}/addresses/${a.id}`,
        };
      });
      c.header("cache-control", "private, max-age=60");
      c.header("x-robots-tag", "noindex");
      if (m[2] === "json") {
        return c.json({
          version: "https://jsonfeed.org/version/1.1",
          title: `${a.siteName} — ${a.localPart}@${domain}`,
          home_page_url: `${base}/addresses/${a.id}`,
          items: entries.map((e) => ({
            id: e.id,
            title: e.title,
            content_text: e.text,
            date_published: new Date(e.received_at).toISOString(),
            url: e.url,
            authors: e.from ? [{ name: e.from }] : [],
            _throwaway: { code: e.code, links: e.links },
          })),
        });
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${esc(`${a.siteName} — ${a.localPart}@${domain}`)}</title><link>${esc(`${base}/addresses/${a.id}`)}</link><description>Throwaway Mail feed</description>
${entries
  .map(
    (e) =>
      `<item><guid isPermaLink="false">${e.id}</guid><title>${esc(e.title)}</title><link>${esc(e.url)}</link><pubDate>${new Date(e.received_at).toUTCString()}</pubDate>${e.from ? `<author>${esc(e.from)}</author>` : ""}<description>${esc(e.text)}</description></item>`,
  )
  .join("\n")}
</channel></rss>`;
      return c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8" });
    },
  );
}
