import { describe, expect, it } from "vitest";
import {
  bodyUnsubscribeLinks,
  pickUnsubscribe,
  unsubscribeCandidates,
  type UnsubscribeCandidate,
} from "../../app/server/parser/unsubscribe.js";

const h = (pairs: Record<string, string>) => Object.entries(pairs).map(([key, value]) => ({ key, value }));
const best = (input: Parameters<typeof unsubscribeCandidates>[0]) => unsubscribeCandidates(input)[0] ?? null;

describe("List-Unsubscribe headers", () => {
  it("detects RFC 8058 one-click", () => {
    const c = best({
      headers: h({
        "list-unsubscribe": "<mailto:u@list.io?subject=unsub>, <https://list.io/u/abc>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }),
    });
    expect(c).toEqual({ kind: "one_click", url: "https://list.io/u/abc", mailto: "mailto:u@list.io?subject=unsub" });
  });
  it("detects a plain https target without the Post header", () =>
    expect(best({ headers: h({ "list-unsubscribe": "<https://list.io/u/abc>" }) })?.kind).toBe("https"));
  it("accepts a bare URL without angle brackets (Slack)", () =>
    expect(
      best({
        headers: h({
          "list-unsubscribe": "https://team.slack.com/unsub/U0-abc",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        }),
      }),
    ).toMatchObject({ kind: "one_click", url: "https://team.slack.com/unsub/U0-abc" }));
  it("detects a mailto-only target", () =>
    expect(best({ headers: h({ "list-unsubscribe": "<mailto:leave@list.io>" }) })).toMatchObject({
      kind: "mailto",
      mailto: "mailto:leave@list.io",
    }));
  it("ignores http targets in the header", () => expect(best({ headers: h({ "list-unsubscribe": "<http://list.io/u>" }) })).toBeNull());
  it("unfolds wrapped header values", () =>
    expect(best({ headers: h({ "list-unsubscribe": "<https://list.io/u/\r\n abc>" }) })?.url).toBe("https://list.io/u/abc"));
});

describe("body links", () => {
  const links = (html: string) => bodyUnsubscribeLinks({ html }).map((c) => c.url ?? c.mailto);
  it("finds English anchor text", () => expect(links(`<a href="https://n.io/x1">Unsubscribe</a>`)).toEqual(["https://n.io/x1"]));
  it("finds French anchor text", () => {
    expect(links(`<a href="https://n.fr/a">Se désinscrire</a>`)).toEqual(["https://n.fr/a"]);
    expect(links(`<a href="https://n.fr/b">Me d&eacute;sabonner</a>`)).toEqual(["https://n.fr/b"]);
    expect(links(`<a href="https://n.fr/c">Gérer les préférences</a>`)).toEqual(["https://n.fr/c"]);
  });
  it("finds manage preferences and opt-out", () => {
    expect(links(`<a href="https://n.io/p">Manage preferences</a>`)).toEqual(["https://n.io/p"]);
    expect(links(`<a href="https://n.io/o">Opt-out</a>`)).toEqual(["https://n.io/o"]);
  });
  it("matches on the URL when the text is generic", () =>
    expect(links(`<a href="https://n.io/unsubscribe?id=1">here</a>`)).toHaveLength(1));
  it("matches through tracking redirects", () =>
    expect(links(`<a href="https://t.io/c?url=https%3A%2F%2Fn.io%2Foptout">click</a>`)).toHaveLength(1));
  it("finds image buttons by alt text", () =>
    expect(links(`<a href="https://n.io/b"><img src="https://n.io/btn.png" alt="Unsubscribe"></a>`)).toEqual(["https://n.io/b"]));
  it("finds buttons by aria-label", () =>
    expect(links(`<a aria-label="Se désabonner" href="https://n.io/z"></a>`)).toEqual(["https://n.io/z"]));
  it("finds form buttons", () =>
    expect(links(`<form action="https://n.io/f" method="post"><button>Unsubscribe</button></form>`)).toEqual(["https://n.io/f"]));
  it("ignores unrelated links and hidden ones", () => {
    expect(links(`<a href="https://n.io/shop">Shop now</a>`)).toEqual([]);
    expect(links(`<div style="display:none"><a href="https://n.io/u">Unsubscribe</a></div>`)).toEqual([]);
  });
  it("finds plain-text links by surrounding words", () => {
    const text = "Thanks for reading.\nTo unsubscribe, visit https://n.io/l/42\nhttps://n.io/blog";
    expect(bodyUnsubscribeLinks({ text }).map((c) => c.url)).toEqual(["https://n.io/l/42"]);
  });
  it("finds a small footer link next to privacy and terms", () => {
    const html = `<table><tr><td style="font-size:11px"><p>OpenAI<br>1st Floor, Dublin 1</p>
      <a href="https://e.customeriomail.com/unsubscribe/dgTQ7wQDAJ_ZBQGXYa1" style="color:#6e6e80;text-decoration:underline" target="_blank">Unsubscribe</a><br>
      <a href="https://openai.com/policies/privacy-policy">Privacy</a> · <a href="https://openai.com/policies/terms-of-use">Terms</a></td></tr></table>`;
    expect(links(html)).toEqual(["https://e.customeriomail.com/unsubscribe/dgTQ7wQDAJ_ZBQGXYa1"]);
  });
  it("deduplicates repeated links", () =>
    expect(links(`<a href="https://n.io/u">Unsubscribe</a> <a href="https://n.io/u">unsubscribe</a>`)).toHaveLength(1));
});

describe("ranking", () => {
  it("prefers header targets over body links", () => {
    const all = unsubscribeCandidates({
      headers: h({ "list-unsubscribe": "<mailto:x@n.io>" }),
      html: `<a href="https://n.io/u">Unsubscribe</a>`,
    });
    expect(all.map((c) => c.kind)).toEqual(["mailto", "body"]);
  });
  it("orders one-click, https, mailto, body and drops duplicates across messages", () => {
    const c = (kind: UnsubscribeCandidate["kind"], url: string | null, mailto: string | null = null): UnsubscribeCandidate => ({
      kind,
      url,
      mailto,
    });
    const r = pickUnsubscribe([
      c("body", "https://a.io/1"),
      c("mailto", null, "mailto:a@a.io"),
      c("https", "https://a.io/2"),
      c("one_click", "https://a.io/1"),
    ]);
    expect(r.map((x) => `${x.kind} ${x.url ?? x.mailto}`)).toEqual([
      "one_click https://a.io/1",
      "https https://a.io/2",
      "mailto mailto:a@a.io",
    ]);
  });
  it("returns nothing for an ordinary message", () => expect(best({ text: "Your code is 123456", html: "<p>Hi</p>" })).toBeNull());
});
