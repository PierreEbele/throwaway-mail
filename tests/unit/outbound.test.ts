import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkOutboundTarget,
  isPrivateHost,
  isPrivateIp,
  pinnedFetch,
  readCapped,
  safeFetch,
  safeFetchNoRedirect,
  siteOf,
} from "../../app/server/lib/outbound.js";
import { safeMailto } from "../../app/server/lib/listheaders.js";

const PUBLIC = "93.184.216.34";

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "192.0.2.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:10.0.0.1",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "2002:7f00:1::",
    "2001:0:4136:e378::1",
    "2001:db8::1",
    "not-an-ip",
    "1:2:3",
  ])("blocks %s", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each([PUBLIC, "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::"])("allows %s", (ip) =>
    expect(isPrivateIp(ip)).toBe(false),
  );
});

describe("isPrivateHost", () => {
  it("blocks local names", () => {
    for (const h of ["localhost", "localhost.", "foo.localhost", "printer.local", "db.internal", "nas.home.arpa", "intranet"])
      expect(isPrivateHost(h)).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });
});

describe("checkOutboundTarget", () => {
  const resolve = async (h: string) => (h === "rebind.example" ? ["127.0.0.1"] : h === "mixed.example" ? [PUBLIC, "10.0.0.1"] : [PUBLIC]);
  it("only allows http(s), or https when asked", async () => {
    for (const u of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/", "javascript:alert(1)", "data:text/html,x"])
      await expect(checkOutboundTarget(u, { resolve })).rejects.toThrow(/http/);
    await expect(checkOutboundTarget("http://example.com/", { resolve, httpsOnly: true })).rejects.toThrow(/https only/);
  });
  it("refuses credentials in the URL", async () => {
    await expect(checkOutboundTarget("https://u:p@example.com/", { resolve })).rejects.toThrow(/credentials/);
  });
  it("refuses private literals, including obfuscated and IPv6 forms", async () => {
    for (const u of [
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://0x7f.1/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:169.254.169.254]/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00:ec2::254]/",
      "https://localhost/",
    ])
      await expect(checkOutboundTarget(u, { resolve })).rejects.toThrow(/private/);
  });
  it("refuses names resolving to a private address (any of them)", async () => {
    await expect(checkOutboundTarget("https://rebind.example/", { resolve })).rejects.toThrow(/private address/);
    await expect(checkOutboundTarget("https://mixed.example/", { resolve })).rejects.toThrow(/private address/);
  });
  it("returns the checked IP to pin", async () => {
    expect((await checkOutboundTarget("https://example.com/", { resolve })).ip).toBe(PUBLIC);
    expect((await checkOutboundTarget("http://10.0.0.1/", { resolve, allowPrivate: true })).ip).toBeNull();
  });
});

describe("safeFetch", () => {
  it("pins the connection to the IP resolved at check time (DNS rebinding)", async () => {
    let n = 0;
    const resolve = async () => (n++ === 0 ? [PUBLIC] : ["127.0.0.1"]);
    const seen: Array<RequestInit & { pinnedIp?: string | null }> = [];
    const fetch = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    await safeFetch({ fetch, resolve }, "https://example.com/", { method: "GET" });
    expect(seen[0]!.pinnedIp).toBe(PUBLIC);
    expect(seen[0]!.redirect).toBe("manual");
    expect(seen[0]!.credentials).toBe("omit");
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("does not fetch at all when the check fails", async () => {
    let called = false;
    const fetch = (async () => ((called = true), new Response(""))) as unknown as typeof globalThis.fetch;
    await expect(safeFetch({ fetch, resolve: async () => ["10.0.0.1"] }, "https://x.example/", {})).rejects.toThrow();
    expect(called).toBe(false);
  });
  it("times out", async () => {
    const fetch = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as unknown as typeof globalThis.fetch;
    await expect(safeFetch({ fetch, resolve: async () => [PUBLIC] }, "https://x.example/", {}, { timeoutMs: 20 })).rejects.toThrow(/abort/);
  });
  it("safeFetchNoRedirect refuses redirects", async () => {
    const fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } })) as unknown as typeof globalThis.fetch;
    await expect(safeFetchNoRedirect({ fetch, resolve: async () => [PUBLIC] }, "https://x.example/", {})).rejects.toThrow(/redirect/);
  });
});

describe("readCapped", () => {
  it("stops reading after the cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024).fill(97));
        if (pulled > 10_000) c.close();
      },
    });
    const text = await readCapped(new Response(stream), 4096);
    expect(text.length).toBe(4096);
    expect(pulled).toBeLessThan(20);
  });
});

describe("pinnedFetch", () => {
  let server: Server;
  let port = 0;
  const hits: Array<{ host?: string; cookie?: string; encoding?: string; body: string }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ host: req.headers.host, cookie: req.headers.cookie, encoding: req.headers["accept-encoding"], body });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "/elsewhere" }).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": "a=1" }).end("pinned");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("connects to the pinned IP while keeping the host name", async () => {
    // "unresolvable.invalid" never resolves: the request can only succeed through the pin.
    const res = await pinnedFetch(new URL(`http://unresolvable.invalid:${port}/x`), "127.0.0.1", {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
    });
    expect(await res.text()).toBe("pinned");
    expect(res.headers.get("set-cookie")).toBe("a=1");
    const hit = hits.at(-1)!;
    expect(hit.host).toBe(`unresolvable.invalid:${port}`);
    expect(hit.body).toBe("List-Unsubscribe=One-Click");
    expect(hit.cookie).toBeUndefined();
    expect(hit.encoding).toBe("identity");
  });
  it("does not follow redirects", async () => {
    const res = await pinnedFetch(new URL(`http://unresolvable.invalid:${port}/redirect`), "127.0.0.1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
  });
  it("rejects non-http schemes and bad pins", async () => {
    await expect(pinnedFetch(new URL("file:///etc/passwd"), "127.0.0.1")).rejects.toThrow();
    await expect(pinnedFetch(new URL("http://x.example/"), "nope")).rejects.toThrow();
  });
});

describe("siteOf", () => {
  it("approximates the registrable domain", () => {
    expect(siteOf("news.example.com")).toBe("example.com");
    expect(siteOf("a.b.example.co.uk")).toBe("example.co.uk");
    expect(siteOf("example.com.")).toBe("example.com");
  });
});

describe("safeMailto", () => {
  it("keeps a single recipient with subject/body", () => {
    expect(safeMailto("mailto:unsub@example.com?subject=unsubscribe")).toBe("mailto:unsub@example.com?subject=unsubscribe");
    expect(safeMailto("MAILTO:unsub@example.com")).toBe("mailto:unsub@example.com");
  });
  it("drops cc/bcc/to and other headers", () => {
    expect(safeMailto("mailto:unsub@example.com?cc=spy@evil.example&bcc=x@evil.example&subject=hi")).toBe(
      "mailto:unsub@example.com?subject=hi",
    );
  });
  it("refuses multiple recipients, malformed addresses, header injection and other schemes", () => {
    expect(safeMailto("mailto:a@example.com,b@evil.example")).toBeNull();
    expect(safeMailto("mailto:not-an-address")).toBeNull();
    expect(safeMailto("mailto:a@example.com?subject=x%0D%0ABcc:spy@evil.example")).toBeNull();
    expect(safeMailto("javascript:alert(1)")).toBeNull();
    expect(safeMailto(null)).toBeNull();
  });
});
