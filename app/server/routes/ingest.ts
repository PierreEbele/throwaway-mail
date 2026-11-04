import { metrics } from "../services/metrics.js";
import type { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { HttpError } from "../lib/errors.js";
import { hmacHex, safeEqual } from "../lib/crypto.js";
import { ingestMessage } from "../services/ingest/index.js";
import { recordAttempts } from "../services/deliveries.js";
import { z } from "zod";

export const INGEST_HEADERS = {
  timestamp: "x-tm-timestamp",
  signature: "x-tm-signature",
  from: "x-tm-envelope-from",
  to: "x-tm-envelope-to",
} as const;

/** The exact bytes the Worker signs: `${timestamp}\n${from}\n${to}\n` followed by the raw MIME body. */
export function ingestSignature(secret: string, timestamp: string, from: string, to: string, body: Uint8Array): string {
  return hmacHex(secret, `${timestamp}\n${from}\n${to}\n`, body);
}

async function readLimited(req: Request, max: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "payload_too_large", `Message exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function registerIngest(app: Hono<AppEnv>) {
  app.post("/ingest", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.ingestEnabled)
      throw new HttpError(503, "ingest_disabled", "INGEST_SECRET is not set: the Cloudflare Worker ingest is disabled");
    const max = deps.config.MAX_INGEST_BYTES;
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > max) throw new HttpError(413, "payload_too_large", `Message exceeds ${max} bytes`);

    const ts = c.req.header(INGEST_HEADERS.timestamp) ?? "";
    const sig = (c.req.header(INGEST_HEADERS.signature) ?? "").toLowerCase();
    const from = c.req.header(INGEST_HEADERS.from) ?? "";
    const to = c.req.header(INGEST_HEADERS.to) ?? "";
    if (!/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig) || !to)
      throw new HttpError(401, "bad_signature", "Missing or malformed signature headers");
    const skew = Math.abs(Math.floor(deps.now() / 1000) - Number(ts));
    if (skew > 300) throw new HttpError(401, "stale_timestamp", "Timestamp outside the allowed 5 minute window");

    const body = await readLimited(c.req.raw, max);
    const expected = ingestSignature(deps.config.INGEST_SECRET, ts, from, to, body);
    if (!safeEqual(sig, expected)) {
      deps.logger.warn("ingest: bad signature", { to_domain: to.split("@")[1] });
      throw new HttpError(401, "bad_signature", "Signature mismatch");
    }
    const result = await ingestMessage(deps, { raw: body, envelopeFrom: from, envelopeTo: to });
    metrics.ingest.inc({ action: result.duplicate ? "duplicate" : result.action, reason: result.reason ?? "" });
    return c.json(result);
  });

  app.post("/ingest/report", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.ingestEnabled) throw new HttpError(503, "ingest_disabled", "INGEST_SECRET is not set");
    const ts = c.req.header(INGEST_HEADERS.timestamp) ?? "";
    const sig = (c.req.header(INGEST_HEADERS.signature) ?? "").toLowerCase();
    if (!/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig))
      throw new HttpError(401, "bad_signature", "Missing or malformed signature headers");
    if (Math.abs(Math.floor(deps.now() / 1000) - Number(ts)) > 300)
      throw new HttpError(401, "stale_timestamp", "Timestamp outside the allowed 5 minute window");
    const body = await readLimited(c.req.raw, 256 * 1024);
    if (!safeEqual(sig, reportSignature(deps.config.INGEST_SECRET, ts, body)))
      throw new HttpError(401, "bad_signature", "Signature mismatch");
    let parsed: z.infer<typeof reportSchema>;
    try {
      parsed = reportSchema.parse(JSON.parse(Buffer.from(body).toString("utf8")));
    } catch {
      throw new HttpError(400, "bad_request", "Invalid report");
    }
    const failed = recordAttempts(deps, parsed.message_id, parsed.deliveries, "cloudflare");
    if (failed) deps.logger.warn("forward failures reported by the Worker", { message_id: parsed.message_id, failed });
    return c.json({ ok: true, recorded: failed });
  });
}

/** Body of POST /ingest/report: what happened to the forwards of one message (sent by the Worker). */
const reportSchema = z.object({
  message_id: z.string().min(1).max(64),
  deliveries: z
    .array(
      z.object({
        to: z.string().trim().toLowerCase().max(254),
        ok: z.boolean(),
        error: z.string().max(2000).optional(),
        fallback_for: z.string().trim().toLowerCase().max(254).optional(),
      }),
    )
    .max(50),
});

/** The Worker signs reports like mail, with "report" as both envelope fields: `${timestamp}\nreport\nreport\n` + JSON body. */
export function reportSignature(secret: string, timestamp: string, body: Uint8Array): string {
  return ingestSignature(secret, timestamp, "report", "report", body);
}
