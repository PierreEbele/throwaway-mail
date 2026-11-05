import { describe, expect, it } from "vitest";
import {
  Jar,
  confirmationForm,
  formTargetAllowed,
  isUnsubscribeSuccess,
  visitUnsubscribe,
} from "../../app/server/services/unsubscribe-visit.js";

type Route = (req: { method: string; url: string; body: string; cookie: string }) => {
  status?: number;
  html?: string;
  location?: string;
  cookie?: string;
};

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const fetch = (async (input: string, init: RequestInit) => {
    const u = new URL(input);
    const key = `${init.method ?? "GET"} ${u.origin}${u.pathname}`;
    const req = {
      method: init.method ?? "GET",
      url: input,
      body: String(init.body ?? ""),
      cookie: (init.headers as Record<string, string>).cookie ?? "",
    };
    calls.push(req);
    const r = routes[key]?.(req) ?? { status: 404, html: "not found" };
    const headers = new Headers();
    if (r.location) headers.set("location", r.location);
    if (r.cookie) headers.append("set-cookie", r.cookie);
    return new Response(r.html ?? "", { status: r.status ?? 200, headers });
  }) as unknown as typeof globalThis.fetch;
  return { deps: { fetch, resolve: async () => ["93.184.216.34"] }, calls };
}

describe("unsubscribe pages", () => {
  it("recognises English and French confirmations", () => {
    expect(isUnsubscribeSuccess("<h1>You have been unsubscribed</h1>")).toBe(true);
    expect(isUnsubscribeSuccess("<p>You've successfully unsubscribed from our emails.</p>")).toBe(true);
    expect(isUnsubscribeSuccess("<p>Vous avez bien été désabonné.</p>")).toBe(true);
    expect(isUnsubscribeSuccess("<p>Votre désinscription a bien été prise en compte</p>")).toBe(true);
    expect(isUnsubscribeSuccess("<p>Are you sure you want to unsubscribe?</p>")).toBe(false);
  });
  it("builds the confirmation request from the form", () => {
    const html = `<form method="post" action="/confirm"><input type="hidden" name="t" value="abc&amp;1">
      <input type="checkbox" name="all" checked><input type="checkbox" name="partner">
      <button type="submit" name="op" value="unsub">Unsubscribe</button></form>`;
    expect(confirmationForm(html, new URL("https://n.io/u/1"))).toEqual({
      url: "https://n.io/confirm",
      method: "POST",
      body: "t=abc%261&all=on&op=unsub",
    });
  });
  it("skips forms that need the user to type something", () =>
    expect(
      confirmationForm(`<form action="/unsub"><input name="email" required><button>Unsubscribe</button></form>`, new URL("https://n.io")),
    ).toBeNull());
  it("ignores unrelated forms", () =>
    expect(confirmationForm(`<form action="/search"><input name="q"><button>Search</button></form>`, new URL("https://n.io"))).toBeNull());
});

describe("visitUnsubscribe", () => {
  it("is done when the link itself unsubscribes, following redirects", async () => {
    const { deps } = fakeFetch({
      "GET https://r.n.io/asm/unsubscribe": () => ({ status: 302, location: "https://n.io/done" }),
      "GET https://n.io/done": () => ({ html: "<h1>You have been unsubscribed.</h1>" }),
    });
    expect(await visitUnsubscribe(deps, "https://r.n.io/asm/unsubscribe?u=1")).toEqual({ done: true, error: null });
  });
  it("submits the confirmation form with the session cookie", async () => {
    const { deps, calls } = fakeFetch({
      "GET https://n.io/u": () => ({
        cookie: "sid=42; Path=/",
        html: `<form method="post" action="/u/confirm"><input type="hidden" name="id" value="7"><button>Confirm</button></form>`,
      }),
      "POST https://n.io/u/confirm": (r) => ({ html: r.cookie === "sid=42" && r.body === "id=7" ? "Vous êtes désabonné" : "error" }),
    });
    expect(await visitUnsubscribe(deps, "https://n.io/u")).toEqual({ done: true, error: null });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });
  it("is not done when the page never confirms", async () => {
    const { deps } = fakeFetch({ "GET https://n.io/u": () => ({ html: "<p>Manage your preferences</p>" }) });
    expect((await visitUnsubscribe(deps, "https://n.io/u")).done).toBe(false);
  });
  it("refuses redirects towards a private network", async () => {
    const { deps, calls } = fakeFetch({ "GET https://n.io/u": () => ({ status: 302, location: "https://127.0.0.1/admin" }) });
    expect((await visitUnsubscribe(deps, "https://n.io/u")).done).toBe(false);
    expect(calls).toHaveLength(1);
  });
  it("reports HTTP errors", async () => {
    const { deps } = fakeFetch({ "GET https://n.io/u": () => ({ status: 500 }) });
    expect(await visitUnsubscribe(deps, "https://n.io/u")).toEqual({ done: false, error: "HTTP 500" });
  });
  it("refuses redirects downgrading to http", async () => {
    const { deps, calls } = fakeFetch({ "GET https://n.io/u": () => ({ status: 302, location: "http://n.io/plain" }) });
    expect(await visitUnsubscribe(deps, "https://n.io/u")).toEqual({ done: false, error: "https only" });
    expect(calls).toHaveLength(1);
  });
  it("caps the number of redirects", async () => {
    const { deps, calls } = fakeFetch({ "GET https://n.io/loop": () => ({ status: 302, location: "https://n.io/loop" }) });
    expect(await visitUnsubscribe(deps, "https://n.io/loop")).toEqual({ done: false, error: "Too many redirects" });
    expect(calls).toHaveLength(6);
  });
  it("re-resolves and refuses a host that rebinds to a private address mid-visit", async () => {
    const { deps, calls } = fakeFetch({ "GET https://n.io/u": () => ({ status: 302, location: "https://evil.example/x" }) });
    const resolve = async (h: string) => (h === "evil.example" ? ["169.254.169.254"] : ["93.184.216.34"]);
    expect((await visitUnsubscribe({ ...deps, resolve }, "https://n.io/u")).error).toMatch(/private address/);
    expect(calls).toHaveLength(1);
  });
  it("pins every hop to the resolved IP and sends no credentials", async () => {
    const seen: Array<RequestInit & { pinnedIp?: string | null }> = [];
    const fetch = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response("You have been unsubscribed");
    }) as unknown as typeof globalThis.fetch;
    await visitUnsubscribe({ fetch, resolve: async () => ["93.184.216.34"] }, "https://n.io/u");
    expect(seen[0]!.pinnedIp).toBe("93.184.216.34");
    expect(seen[0]!.credentials).toBe("omit");
    expect((seen[0]!.headers as Record<string, string>).cookie).toBeUndefined();
  });
  it("never sends a host's cookies to another host", async () => {
    const { deps, calls } = fakeFetch({
      "GET https://n.io/u": () => ({ cookie: "sid=secret", status: 302, location: "https://other.example/u" }),
      "GET https://other.example/u": () => ({ html: "You have been unsubscribed" }),
    });
    expect((await visitUnsubscribe(deps, "https://n.io/u")).done).toBe(true);
    expect((calls[1] as unknown as { cookie: string }).cookie).toBe("");
  });
  it("does not submit a confirmation form to another site", async () => {
    const { deps, calls } = fakeFetch({
      "GET https://n.io/u": () => ({
        html: `<form method="post" action="https://attacker.example/unsubscribe"><button>Confirm</button></form>`,
      }),
    });
    expect(await visitUnsubscribe(deps, "https://n.io/u")).toEqual({
      done: false,
      error: "The confirmation form points to another site",
    });
    expect(calls).toHaveLength(1);
  });
  it("allows forms on the same site, refuses non-https targets", () => {
    const page = new URL("https://www.n.io/u");
    expect(formTargetAllowed("https://lists.n.io/confirm", page, page)).toBe(true);
    expect(formTargetAllowed("https://esp.example/confirm", page, new URL("https://esp.example/u"))).toBe(true);
    expect(formTargetAllowed("http://n.io/confirm", page, page)).toBe(false);
    expect(formTargetAllowed("javascript:alert(1)", page, page)).toBe(false);
    expect(formTargetAllowed("https://u:p@n.io/confirm", page, page)).toBe(false);
  });
  it("caps the size of the page it reads", async () => {
    const big = "x".repeat(2 * 1024 * 1024) + "You have been unsubscribed";
    const { deps } = fakeFetch({ "GET https://n.io/u": () => ({ html: big }) });
    expect((await visitUnsubscribe(deps, "https://n.io/u")).done).toBe(false);
  });
});

describe("Jar", () => {
  it("scopes cookies by host and drops malformed ones", () => {
    const jar = new Jar();
    const res = new Response("", {
      headers: [
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "bad name=2"],
      ],
    });
    jar.add("n.io", res);
    expect(jar.header("n.io")).toBe("a=1");
    expect(jar.header("other.example")).toBe("");
  });
});
