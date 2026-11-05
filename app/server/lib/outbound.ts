import { lookup, resolveMx } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Resolves a host name to its IP addresses (replaced in tests). */
export type Resolver = (host: string) => Promise<string[]>;

export const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** MX records of a domain, best (lowest priority) first; [] when it has none (replaced in tests). */
export type MxResolver = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;

export const dnsMxResolver: MxResolver = async (domain) => {
  try {
    return (await resolveMx(domain)).sort((a, b) => a.priority - b.priority);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENODATA" || (e as NodeJS.ErrnoException).code === "ENOTFOUND") return [];
    throw e;
  }
};

/** The 8 hextets of an IPv6 address (embedded dotted IPv4 tails included), or null. */
function ipv6Words(ip: string): number[] | null {
  let v = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (tail) {
    const p = tail[1]!.split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    v = v.slice(0, -tail[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const words = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return words.length === 8 && words.every((w) => Number.isInteger(w)) ? words : null;
}

const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Addresses the server must never reach on behalf of untrusted input: loopback, private, link-local (cloud metadata
 * 169.254.169.254), CGNAT, benchmarking, documentation, multicast, reserved and unspecified, plus IPv6 forms that embed
 * an IPv4 address (mapped, compatible, NAT64, 6to4), Teredo, unique-local (fd00:ec2::254) and link-local ranges.
 * Anything unparsable counts as private.
 */
export function isPrivateIp(ip: string): boolean {
  const v = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (isIP(v) === 4) {
    const [a, b, c] = v.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(v) !== 6) return true;
  const w = ipv6Words(v);
  if (!w) return true;
  const zero = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (zero(8)) return true; // ::
  if (zero(7) && w[7] === 1) return true; // ::1
  if (zero(5) && w[5] === 0xffff) return isPrivateIp(v4of(w[6]!, w[7]!)); // ::ffff:a.b.c.d (mapped)
  if (zero(6)) return isPrivateIp(v4of(w[6]!, w[7]!)); // ::a.b.c.d (IPv4-compatible)
  if (w[0] === 0x64 && w[1] === 0xff9b) return isPrivateIp(v4of(w[6]!, w[7]!)); // NAT64
  if (w[0] === 0x2002) return isPrivateIp(v4of(w[1]!, w[2]!)); // 6to4
  if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // discard-only
  const top = w[0]!;
  return (
    (top & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (top & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (top & 0xffc0) === 0xfec0 || // site-local fec0::/10
    (top & 0xff00) === 0xff00 // multicast
  );
}

/** Names that only make sense on a local network. */
export function isPrivateHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (isIP(h)) return isPrivateIp(h);
  return !h.includes(".") || /(^|\.)(localhost|local|lan|internal|intranet|localdomain|home\.arpa)$/.test(h);
}

export class OutboundUrlError extends Error {}

export interface OutboundTarget {
  url: URL;
  /** The checked address to connect to (DNS-rebinding guard); null when private targets are allowed. */
  ip: string | null;
}

/**
 * Checks that `raw` may be fetched by the server: http(s), no credentials, and (unless `allowPrivate`) a host that
 * neither looks local nor resolves to a private address. Returns the checked IP so the connection can be pinned to it
 * (see `safeFetch`): connecting by name again would let a rebinding DNS server swap the answer.
 */
export async function checkOutboundTarget(
  raw: string,
  opts: { resolve: Resolver; allowPrivate?: boolean; httpsOnly?: boolean },
): Promise<OutboundTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError("not a valid URL");
  }
  if (url.protocol !== "https:" && (opts.httpsOnly || url.protocol !== "http:"))
    throw new OutboundUrlError(opts.httpsOnly ? "https only" : "http(s) only");
  if (url.username || url.password) throw new OutboundUrlError("credentials in the URL are not allowed");
  if (opts.allowPrivate) return { url, ip: null };
  if (isPrivateHost(url.hostname)) throw new OutboundUrlError("private or local host");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : await opts.resolve(host).catch(() => []);
  if (!ips.length) throw new OutboundUrlError(`cannot resolve ${host}`);
  if (ips.some(isPrivateIp)) throw new OutboundUrlError(`${host} resolves to a private address`);
  return { url, ip: ips[0]! };
}

/** `checkOutboundTarget` for callers that only need the URL (validation at save time). */
export async function checkOutboundUrl(
  raw: string,
  opts: { resolve: Resolver; allowPrivate?: boolean; httpsOnly?: boolean },
): Promise<URL> {
  return (await checkOutboundTarget(raw, opts)).url;
}

/** Request options understood by the server's outbound fetch: `pinnedIp` makes it connect to that address only. */
export type OutboundInit = RequestInit & { pinnedIp?: string | null };

/**
 * HTTP(S) request that connects to `ip` whatever DNS now says about the host, keeping the host name for the Host
 * header, SNI and certificate validation. Never follows redirects, never sends cookies, never decompresses.
 */
export function pinnedFetch(url: URL, ip: string, init: RequestInit = {}): Promise<Response> {
  const family = isIP(ip);
  if (!family) return Promise.reject(new OutboundUrlError("invalid pinned address"));
  const secure = url.protocol === "https:";
  if (!secure && url.protocol !== "http:") return Promise.reject(new OutboundUrlError("http(s) only"));
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
  headers["accept-encoding"] = "identity";
  const b = init.body;
  const body =
    b == null
      ? undefined
      : typeof b === "string" || b instanceof URLSearchParams
        ? Buffer.from(String(b))
        : b instanceof ArrayBuffer || ArrayBuffer.isView(b)
          ? Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
          : null;
  if (body === null) return Promise.reject(new OutboundUrlError("unsupported request body"));
  if (body !== undefined) headers["content-length"] = String(body.byteLength);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const method = (init.method ?? "GET").toUpperCase();
  const pin = (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
    opts?.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family);
  return new Promise<Response>((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        signal: init.signal ?? undefined,
        agent: false,
        ...(secure && !isIP(host) ? { servername: host } : {}),
        lookup: pin as never,
      },
      (res) => {
        const h = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const status = res.statusCode ?? 502;
        const empty = method === "HEAD" || status === 204 || status === 205 || status === 304 || status < 200;
        if (empty) res.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status: status < 200 || status > 599 ? 502 : status,
            headers: h,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The server's real outbound fetch: pinned to the checked IP when asked to, the global fetch otherwise. */
export const outboundFetch = ((input: string | URL | Request, init?: OutboundInit) => {
  const { pinnedIp, ...rest } = init ?? {};
  if (pinnedIp) return pinnedFetch(new URL(input instanceof Request ? input.url : String(input)), pinnedIp, rest);
  return fetch(input, rest);
}) as typeof fetch;

export interface SafeFetchDeps {
  fetch: typeof fetch;
  resolve: Resolver;
}

export interface SafeFetchOptions {
  allowPrivate?: boolean;
  httpsOnly?: boolean;
  /** Per-request timeout; ignored when `init.signal` is given. */
  timeoutMs?: number;
}

/**
 * One request towards an untrusted URL: checked (scheme, credentials, private ranges), pinned to the checked IP,
 * time-limited, with redirects left to the caller (every hop must go through `safeFetch` again) and no ambient
 * credentials.
 */
export async function safeFetch(
  deps: SafeFetchDeps,
  raw: string,
  init: RequestInit,
  opts: SafeFetchOptions = {},
): Promise<{ res: Response; url: URL }> {
  const { url, ip } = await checkOutboundTarget(raw, {
    resolve: deps.resolve,
    allowPrivate: opts.allowPrivate,
    httpsOnly: opts.httpsOnly,
  });
  const signal = init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const req: OutboundInit = { ...init, redirect: "manual", credentials: "omit", signal, pinnedIp: ip };
  const res = await deps.fetch(url.toString(), req);
  return { res, url };
}

/** `safeFetch` for endpoints that must answer directly: a redirect is an error, as with `redirect: "error"`. */
export async function safeFetchNoRedirect(
  deps: SafeFetchDeps,
  raw: string,
  init: RequestInit,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const { res } = await safeFetch(deps, raw, init, opts);
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => {});
    throw new OutboundUrlError(`redirects are not followed (HTTP ${res.status})`);
  }
  return res;
}

/** Reads at most `max` bytes of a response body as text, then drops the rest. */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "ne", "or", "gouv", "asso"]);

/** Registrable-domain approximation: the last two labels, three under a common second level such as co.uk. */
export function siteOf(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (isIP(h)) return h;
  const parts = h.split(".");
  const n = parts.length >= 3 && SECOND_LEVEL.has(parts.at(-2)!) && parts.at(-1)!.length === 2 ? 3 : 2;
  return parts.slice(-n).join(".");
}
