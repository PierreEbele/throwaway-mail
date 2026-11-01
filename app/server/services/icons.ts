import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Deps } from "../context.js";
import { DAY } from "../lib/time.js";

// Site logos are fetched server-side from DuckDuckGo's favicon service, so browsers never contact it,
// and cached on disk (DATA_DIR/icons).
const PROVIDER = (host: string) => `https://icons.duckduckgo.com/ip3/${host}.ico`;
const TTL = 30 * DAY;
/** A site without a logo is retried the next day. */
const MISS_TTL = DAY;
const MAX_BYTES = 256 * 1024;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function iconHost(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  return HOST_RE.test(host) ? host : null;
}

const iconDir = (d: Deps) => path.join(d.config.DATA_DIR, "icons");

/** Age in ms of a cache file, or null when it does not exist. */
async function age(d: Deps, file: string): Promise<number | null> {
  try {
    return d.now() - (await stat(file)).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const inflight = new Map<string, Promise<Buffer | null>>();

export async function siteIcon(d: Deps, host: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  const dir = iconDir(d);
  const file = path.join(dir, `${host}.ico`);
  const miss = path.join(dir, `${host}.miss`);
  const hit = await age(d, file);
  if (hit !== null && hit < TTL) return readFile(file);
  const missed = await age(d, miss);
  if (missed !== null && missed < MISS_TTL) return null;
  if (inflight.has(host)) return inflight.get(host)!;
  const job = (async () => {
    const buf = await download(host, fetchImpl);
    await mkdir(dir, { recursive: true });
    await writeFile(buf ? file : miss, buf ?? "");
    return buf;
  })().finally(() => inflight.delete(host));
  inflight.set(host, job);
  return job;
}

async function download(host: string, fetchImpl: typeof fetch): Promise<Buffer | null> {
  try {
    const res = await fetchImpl(PROVIDER(host), { signal: AbortSignal.timeout(5000), redirect: "follow" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
    const b = Buffer.from(await res.arrayBuffer());
    // SVG can carry script: never cached nor served from our origin.
    return b.length > 0 && b.length <= MAX_BYTES && iconType(b) !== "image/svg+xml" ? b : null;
  } catch {
    return null; // network failure or timeout: treated as "no logo" and retried after MISS_TTL
  }
}

/** Deletes cached logos older than their TTL. Returns the number of files removed. */
export async function pruneIconCache(d: Deps): Promise<number> {
  const dir = iconDir(d);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const a = await age(d, path.join(dir, name));
    if (a !== null && a > (name.endsWith(".miss") ? MISS_TTL : TTL)) {
      await rm(path.join(dir, name), { force: true });
      removed++;
    }
  }
  return removed;
}

/** Image type from the first bytes (the provider returns ico, png, svg or jpeg). */
export function iconType(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b.subarray(0, 5).toString() === "<?xml" || b.subarray(0, 4).toString() === "<svg") return "image/svg+xml";
  return "image/x-icon";
}
