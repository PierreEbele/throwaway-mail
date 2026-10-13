import fs from "node:fs";
import path from "node:path";
import type { Deps } from "../context.js";

// Logos de sites (favicons) récupérés via DuckDuckGo, côté serveur : le navigateur ne contacte
// jamais le fournisseur, et chaque logo est gardé sur disque (DATA_DIR/icons) 30 jours.
const PROVIDER = (host: string) => `https://icons.duckduckgo.com/ip3/${host}.ico`;
const TTL = 30 * 86400_000;
const MISS_TTL = 86400_000; // un site sans logo est réessayé le lendemain
const MAX_BYTES = 256 * 1024;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function iconHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^www\./, "");
  return HOST_RE.test(host) ? host : null;
}

const inflight = new Map<string, Promise<Buffer | null>>();

export async function siteIcon(d: Deps, host: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  const dir = path.join(d.config.DATA_DIR, "icons");
  const file = path.join(dir, `${host}.ico`);
  const miss = path.join(dir, `${host}.miss`);
  try {
    if (d.now() - fs.statSync(file).mtimeMs < TTL) return fs.readFileSync(file);
  } catch { /* pas en cache */ }
  try {
    if (d.now() - fs.statSync(miss).mtimeMs < MISS_TTL) return null;
  } catch { /* jamais raté */ }
  if (inflight.has(host)) return inflight.get(host)!;
  const job = (async () => {
    let buf: Buffer | null = null;
    try {
      const res = await fetchImpl(PROVIDER(host), { signal: AbortSignal.timeout(5000), redirect: "follow" });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("image/")) {
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > 0 && b.length <= MAX_BYTES) buf = b;
      }
    } catch { /* réseau : traité comme absent */ }
    fs.mkdirSync(dir, { recursive: true });
    if (buf) fs.writeFileSync(file, buf);
    else fs.writeFileSync(miss, "");
    return buf;
  })().finally(() => inflight.delete(host));
  inflight.set(host, job);
  return job;
}

/** Type d'image d'après les premiers octets (le fournisseur renvoie ico/png/svg/jpeg). */
export function iconType(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b.subarray(0, 5).toString() === "<?xml" || b.subarray(0, 4).toString() === "<svg") return "image/svg+xml";
  return "image/x-icon";
}
