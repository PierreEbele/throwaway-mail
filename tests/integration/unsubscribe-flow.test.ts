import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin } from "../helpers.js";

type Handler = (req: { url: string; method: string; body: string; headers: Record<string, string> }) => Response;

/** Fake web: each https URL (without query) answers with its handler; every request is recorded. */
function fakeWeb(t: ReturnType<typeof makeTestApp>, routes: Record<string, Handler>) {
  const calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = [];
  t.deps.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const req = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : "",
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(req);
    const u = new URL(url);
    const h = routes[`${u.origin}${u.pathname}`];
    return h ? h(req) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(`<!doctype html><html><body>${body}</body></html>`, { ...init, headers: { "content-type": "text/html", ...init.headers } });

function newsletter(opts: { headers?: string[]; body?: string; from?: string }) {
  return [
    `From: ${opts.from ?? "News <news@shop.com>"}`,
    "To: x@mail.example.test",
    "Subject: Weekly deals",
    `Message-ID: <${Math.random().toString(36).slice(2)}@shop.com>`,
    "Precedence: bulk",
    ...(opts.headers ?? []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    opts.body ?? "Big deals this week.",
    "",
  ].join("\r\n");
}

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  t.deps.fetch = (async () => new Response("ok")) as typeof fetch;
  const a = (await user.post("/v1/addresses", { site_name: "Shop" })).json.address;
  const receive = async (eml: string) => {
    await ingest(t, a.email, eml);
    return (await user.get(`/v1/addresses/${a.id}/messages`)).json.messages[0];
  };
  return { t, user, a, receive };
}

describe("unsubscribe flow", () => {
  it("opens the page, submits its confirmation form with the session cookie, and stops offering that sender", async () => {
    const { t, user, a, receive } = await setup();
    const calls = fakeWeb(t, {
      "https://shop.com/unsub": () =>
        html(
          `<h1>Leaving so soon?</h1><form method="post" action="/unsub/confirm"><input type="hidden" name="u" value="42">` +
            `<button type="submit" name="action" value="unsubscribe">Unsubscribe</button></form>`,
          { headers: { "set-cookie": "sid=abc; Path=/; HttpOnly" } },
        ),
      "https://shop.com/unsub/confirm": (req) =>
        req.method === "POST" && req.headers.cookie === "sid=abc" && req.body === "u=42&action=unsubscribe"
          ? new Response(null, { status: 303, headers: { location: "/unsub/done" } })
          : html("<p>Error</p>", { status: 400 }),
      "https://shop.com/unsub/done": () => html("<p>You have been unsubscribed from our list.</p>"),
    });
    const m = await receive(newsletter({ headers: ["List-Unsubscribe: <https://shop.com/unsub?id=7>"] }));
    const offer = (await user.get(`/v1/addresses/${a.id}/unsubscribe`)).json;
    expect(offer.offer).toMatchObject({ message_id: m.id, url: "https://shop.com/unsub?id=7", from: "news@shop.com" });
    expect(offer.senders).toBe(1);

    const r = await user.post(`/v1/messages/${m.id}/unsubscribe`, {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ done: true, error: null, url: null, mailto: null, blocked: false });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://shop.com/unsub?id=7",
      "POST https://shop.com/unsub/confirm",
      "GET https://shop.com/unsub/done",
    ]);
    expect((await user.get(`/v1/addresses/${a.id}/unsubscribe`)).json).toEqual({ offer: null, senders: 0 });
  });

  it("returns the link to open when the page does not confirm, and keeps offering it", async () => {
    const { t, user, a, receive } = await setup();
    fakeWeb(t, { "https://shop.com/prefs": () => html("<p>Manage your preferences</p><a href='/x'>Save</a>") });
    const m = await receive(newsletter({ headers: ["List-Unsubscribe: <https://shop.com/prefs?u=1>, <mailto:unsub@shop.com>"] }));
    const r = (await user.post(`/v1/messages/${m.id}/unsubscribe`, {})).json;
    expect(r).toMatchObject({ done: false, error: "The page needs a manual confirmation", url: "https://shop.com/prefs?u=1" });
    expect(r.mailto).toContain("unsub@shop.com");
    expect((await user.get(`/v1/addresses/${a.id}/unsubscribe`)).json.offer.message_id).toBe(m.id);
  });

  it("follows an unsubscribe link found only in the body", async () => {
    const { t, user, a, receive } = await setup();
    const calls = fakeWeb(t, { "https://weekly.example/unsubscribe": () => html("<p>Vous êtes bien désabonné.</p>") });
    const m = await receive(newsletter({ body: "Not interested any more?\r\nUnsubscribe: https://weekly.example/unsubscribe?id=9" }));
    expect((await user.get(`/v1/addresses/${a.id}/unsubscribe`)).json.offer).toMatchObject({
      kind: "body",
      url: "https://weekly.example/unsubscribe?id=9",
    });
    expect((await user.post(`/v1/messages/${m.id}/unsubscribe`, { block: true })).json).toMatchObject({ done: true, blocked: true });
    expect(calls[0]!.url).toBe("https://weekly.example/unsubscribe?id=9");
    expect((await user.get(`/v1/addresses/${a.id}`)).json.address.block_promos).toBe(true);
  });

  it("refuses redirects into the private network and reports HTTP errors", async () => {
    const { t, user, receive } = await setup();
    t.deps.resolve = async (h: string) => (h === "intranet.shop.com" ? ["10.0.0.8"] : ["93.184.216.34"]);
    const calls = fakeWeb(t, {
      "https://shop.com/bounce": () => new Response(null, { status: 302, headers: { location: "https://intranet.shop.com/admin" } }),
      "https://shop.com/broken": () => html("oops", { status: 500 }),
    });
    const m1 = await receive(newsletter({ headers: ["List-Unsubscribe: <https://shop.com/bounce>"] }));
    const r1 = (await user.post(`/v1/messages/${m1.id}/unsubscribe`, {})).json;
    expect(r1).toMatchObject({ done: false, url: "https://shop.com/bounce" });
    expect(r1.error).toContain("private");
    expect(calls.some((c) => c.url.includes("intranet"))).toBe(false);

    const m2 = await receive(newsletter({ headers: ["List-Unsubscribe: <https://shop.com/broken>"], from: "Other <o@shop.com>" }));
    expect((await user.post(`/v1/messages/${m2.id}/unsubscribe`, {})).json).toMatchObject({ done: false, error: "HTTP 500" });
  });

  it("reports a failed one-click request and ignores plain http links", async () => {
    const { t, user, receive } = await setup();
    const calls = fakeWeb(t, { "https://shop.com/oneclick": () => new Response("no", { status: 503 }) });
    const m1 = await receive(
      newsletter({ headers: ["List-Unsubscribe: <https://shop.com/oneclick>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] }),
    );
    expect((await user.post(`/v1/messages/${m1.id}/unsubscribe`, {})).json).toMatchObject({
      done: false,
      error: "HTTP 503",
      url: "https://shop.com/oneclick",
    });
    expect(calls[0]).toMatchObject({ method: "POST", body: "List-Unsubscribe=One-Click" });

    const before = calls.length;
    const m2 = await receive(newsletter({ headers: ["List-Unsubscribe: <http://plain.shop.com/u>"], from: "P <p@shop.com>" }));
    // Plain http unsubscribe links are not kept as targets.
    expect((await user.post(`/v1/messages/${m2.id}/unsubscribe`, {})).status).toBe(400);
    expect(calls).toHaveLength(before);
  });

  it("refuses messages without a link and other users' messages", async () => {
    const { t, user, receive } = await setup();
    const m = await receive(newsletter({ body: "Plain text, nothing to click." }));
    expect((await user.post(`/v1/messages/${m.id}/unsubscribe`, {})).status).toBe(400);
    const other = loginAs(t, "other@example.org");
    expect((await other.post(`/v1/messages/${m.id}/unsubscribe`, {})).status).toBe(404);
  });
});
