import { lookup, resolveMx } from "node:dns/promises";
import { isIP } from "node:net";

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

/** Loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIp(mapped[1]!);
  if (isIP(v) === 6) return v === "::" || v === "::1" || /^(fe[89ab]|fc|fd)/.test(v);
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return true;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Names that only make sense on a local network. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(h)) return isPrivateIp(h);
  return !h.includes(".") || /(^|\.)(localhost|local|lan|internal|home\.arpa)$/.test(h);
}

export class OutboundUrlError extends Error {}

/**
 * Checks that `raw` may be fetched by the server: http(s), no credentials, and (unless `allowPrivate`) a host that
 * neither looks local nor resolves to a private address. Resolution happens again at connect time, so this narrows
 * but does not fully close DNS-rebinding; run the app without access to sensitive internal services.
 */
export async function checkOutboundUrl(
  raw: string,
  opts: { resolve: Resolver; allowPrivate?: boolean; httpsOnly?: boolean },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError("not a valid URL");
  }
  if (url.protocol !== "https:" && (opts.httpsOnly || url.protocol !== "http:"))
    throw new OutboundUrlError(opts.httpsOnly ? "https only" : "http(s) only");
  if (url.username || url.password) throw new OutboundUrlError("credentials in the URL are not allowed");
  if (opts.allowPrivate) return url;
  if (isPrivateHost(url.hostname)) throw new OutboundUrlError("private or local host");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : await opts.resolve(host).catch(() => []);
  if (!ips.length) throw new OutboundUrlError(`cannot resolve ${host}`);
  if (ips.some(isPrivateIp)) throw new OutboundUrlError(`${host} resolves to a private address`);
  return url;
}
