/**
 * Throwaway Mail — Cloudflare Email Worker.
 * Receives every mail of every managed domain (catch-all rule), hands it to the app, and applies the app's decision:
 *   forward → message.forward(each of forward_to_all, or forward_to), SEND_EMAIL for each `send` copy; a failed
 *             destination is replaced by the first fallback_to that accepts it, and failures are reported to
 *             /ingest/report
 *   reject → message.setReject()   store_only → nothing
 * If the app is unreachable / errors / times out (FALLBACK_MODE=forward, the default), the mail is forwarded to the
 * address's last known destinations (ROUTES KV cache) or else to FALLBACK_FORWARD; a copy is queued on RETRY_QUEUE so
 * the app stores it once it is back, and ALERT_WEBHOOK is told. With nowhere to forward it (or FALLBACK_MODE=reject)
 * the mail is rejected with a temporary error, so the sending server retries later: mail is never silently dropped.
 */

// Minimal structural types so this file has no build-time dependency (workers-types is only needed for wrangler).
export interface EmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

/** Structural views of the optional KV and Queue bindings. */
export interface RouteStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface RetryMessage {
  from: string;
  to: string;
  raw_base64: string;
  received_at: number;
}
export interface RetryQueue {
  send(body: RetryMessage): Promise<void>;
}
export interface QueueBatchLike {
  readonly messages: ReadonlyArray<{
    readonly body: unknown;
    readonly attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }>;
}

export interface Env {
  /** send_email binding: only needed for PGP-encrypted forwards. */
  SEND_EMAIL?: { send(message: unknown): Promise<void> };
  APP_URL: string;
  INGEST_SECRET: string;
  FALLBACK_FORWARD?: string;
  INGEST_TIMEOUT_MS?: string;
  /** "forward" (default): forward to the cached destinations or FALLBACK_FORWARD; "reject": temporary error only. */
  FALLBACK_MODE?: string;
  /** Optional KV namespace: last known forward targets per recipient, used while the app is unreachable. */
  ROUTES?: RouteStore;
  /** Days a cached route stays valid (default 30). */
  ROUTE_TTL_DAYS?: string;
  /** Optional Queue: mail forwarded by the fallback is replayed to /ingest once the app is back (consumer below). */
  RETRY_QUEUE?: RetryQueue;
  /** Optional URL POSTed (JSON) each time the fallback is used, e.g. an ntfy topic or a monitoring webhook. */
  ALERT_WEBHOOK?: string;
}

interface Decision {
  action: "forward" | "store_only" | "reject";
  forward_to?: string;
  forward_to_all?: string[];
  /** Copies to send as new messages (needs the SEND_EMAIL binding): PGP-encrypted (`encrypted`) or changed copies. */
  send?: Array<{ from: string; to: string; raw_base64: string; encrypted?: boolean }>;
  /** Tried in order when forwarding (or sending a clear copy) to a destination fails. */
  fallback_to?: string[];
  reason?: string;
  message_id?: string;
  duplicate?: boolean;
}

/** One delivery attempt, as reported to the app (POST /ingest/report). */
export interface DeliveryAttempt {
  to: string;
  ok: boolean;
  error?: string;
  /** The destination this attempt replaced (a fallback). */
  fallback_for?: string;
}

export type Outcome = "forwarded" | "stored" | "rejected" | "fallback_forwarded" | "temp_rejected";

/** Queue messages are limited to 128 KB; larger mails are only forwarded (the app never sees them). */
const MAX_QUEUED_RAW = 90 * 1024;

const enc = new TextEncoder();

async function sign(secret: string, prefix: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const p = enc.encode(prefix);
  const data = new Uint8Array(p.byteLength + body.byteLength);
  data.set(p, 0);
  data.set(body, p.byteLength);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds a cloudflare:email EmailMessage (injected so tests run outside workerd). */
export type MakeEmail = (from: string, to: string, raw: string) => unknown;

/** Signed POST of one mail to the app's /ingest; throws on network errors, timeouts and non-2xx answers. */
async function postIngest(
  env: Env,
  from: string,
  to: string,
  raw: Uint8Array<ArrayBuffer>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Decision> {
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await sign(env.INGEST_SECRET, `${ts}\n${from}\n${to}\n`, raw);
  const res = await fetchImpl(`${env.APP_URL.replace(/\/$/, "")}/ingest`, {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "x-tm-timestamp": ts,
      "x-tm-signature": signature,
      "x-tm-envelope-from": from,
      "x-tm-envelope-to": to,
    },
    body: raw,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`app answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Decision;
}

const routeKey = (rcpt: string) => `route:${rcpt.toLowerCase()}`;

/** Remembers where the app forwards this recipient, so the fallback can do the same while the app is down. */
async function rememberRoute(env: Env, rcpt: string, targets: string[]) {
  if (!env.ROUTES) return;
  try {
    const key = routeKey(rcpt);
    const value = targets.length ? JSON.stringify([...targets].sort()) : null;
    const old = await env.ROUTES.get(key);
    if (old === value) return;
    if (value) await env.ROUTES.put(key, value, { expirationTtl: Number(env.ROUTE_TTL_DAYS || 30) * 86400 });
    else if (old !== null) await env.ROUTES.delete(key);
  } catch (err) {
    console.error(JSON.stringify({ msg: "route cache update failed", err: String(err) }));
  }
}

/**
 * Forwards to every target and sends every copy; when one fails, the decision's fallback_to destinations are tried
 * in order until one accepts it (encrypted copies are never redirected). A forwarding failure must not bounce the
 * mail: it is stored in the app already.
 */
async function deliver(
  message: EmailMessageLike,
  decision: Decision,
  targets: string[],
  env: Env,
  makeEmail?: MakeEmail,
): Promise<DeliveryAttempt[]> {
  const attempts: DeliveryAttempt[] = [];
  const delivered = new Set<string>();
  const planned = new Set([...targets, ...(decision.send ?? []).map((m) => m.to)]);
  const tryOne = async (to: string, run: () => Promise<void>, fallbackFor?: string) => {
    try {
      await run();
      delivered.add(to);
      attempts.push({ to, ok: true, ...(fallbackFor ? { fallback_for: fallbackFor } : {}) });
      return true;
    } catch (err) {
      console.error(JSON.stringify({ msg: fallbackFor ? "fallback failed" : "forward failed", to, err: String(err) }));
      attempts.push({ to, ok: false, error: String(err).slice(0, 500), ...(fallbackFor ? { fallback_for: fallbackFor } : {}) });
      return false;
    }
  };
  const withFallback = async (to: string, run: (dest: string) => Promise<void>, allowed: boolean) => {
    if ((await tryOne(to, () => run(to))) || !allowed) return;
    for (const fb of decision.fallback_to ?? []) {
      if (delivered.has(fb) || planned.has(fb)) continue;
      if (await tryOne(fb, () => run(fb), to)) return;
    }
  };
  for (const to of targets) await withFallback(to, (dest) => message.forward(dest), true);
  for (const m of decision.send ?? []) {
    const send = async (dest: string) => {
      if (!env.SEND_EMAIL || !makeEmail) throw new Error("SEND_EMAIL binding missing (needed for PGP-encrypted and rewritten forwarding)");
      const raw = new TextDecoder().decode(Uint8Array.from(atob(m.raw_base64), (c) => c.charCodeAt(0)));
      await env.SEND_EMAIL.send(makeEmail(m.from, dest, raw));
    };
    await withFallback(m.to, send, !m.encrypted);
  }
  return attempts;
}

/** Tells the app which forwards failed and which fallbacks took over (signed like /ingest). Best effort. */
async function report(env: Env, fetchImpl: typeof fetch, messageId: string, deliveries: DeliveryAttempt[]) {
  try {
    const body = enc.encode(JSON.stringify({ message_id: messageId, deliveries }));
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await sign(env.INGEST_SECRET, `${ts}\nreport\nreport\n`, body);
    const res = await fetchImpl(`${env.APP_URL.replace(/\/$/, "")}/ingest/report`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tm-timestamp": ts, "x-tm-signature": signature },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(JSON.stringify({ msg: "delivery report failed", message_id: messageId, err: String(err) }));
  }
}

export async function handleEmail(
  message: EmailMessageLike,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  makeEmail?: MakeEmail,
): Promise<Outcome> {
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const timeout = Number(env.INGEST_TIMEOUT_MS || 5000);

  let decision: Decision;
  try {
    decision = await postIngest(env, message.from, message.to, raw, fetchImpl, timeout);
  } catch (err) {
    console.error(JSON.stringify({ msg: "ingest failed", to: message.to, err: String(err) }));
    return fallback(message, raw, env, String(err), fetchImpl);
  }
  const targets =
    decision.action === "forward"
      ? decision.forward_to_all?.length
        ? decision.forward_to_all
        : decision.forward_to
          ? [decision.forward_to]
          : []
      : [];
  await rememberRoute(env, message.to, targets);

  switch (decision.action) {
    case "forward": {
      const attempts = await deliver(message, decision, targets, env, makeEmail);
      if (decision.message_id && !decision.duplicate && attempts.some((a) => !a.ok))
        await report(env, fetchImpl, decision.message_id, attempts);
      return attempts.some((a) => a.ok) ? "forwarded" : "stored";
    }
    case "reject":
      message.setReject(
        decision.reason === "unknown_recipient" || decision.reason === "unknown_domain"
          ? "Unknown recipient"
          : "Recipient not accepting mail",
      );
      return "rejected";
    default:
      return "stored";
  }
}

/**
 * FALLBACK_FORWARD is either one address ("me@x.com") or a per-domain list
 * ("example.com=a@x.com,example.org=b@y.com,*=default@z.com"); a domain entry also covers its sub-domains.
 */
export function fallbackFor(spec: string | undefined, rcpt: string): string | null {
  if (!spec?.trim()) return null;
  if (!spec.includes("=")) return spec.trim();
  const domain = (rcpt.split("@")[1] ?? "").toLowerCase().replace(/>$/, "");
  let star: string | null = null;
  let best: { d: string; to: string } | null = null;
  for (const part of spec.split(",")) {
    const [d, to] = part.split("=").map((x) => x?.trim().toLowerCase());
    if (!d || !to) continue;
    if (d === "*") star = to;
    else if ((domain === d || domain.endsWith("." + d)) && (!best || d.length > best.d.length)) best = { d, to };
  }
  return best?.to ?? star;
}

/** Where the fallback sends a mail: the recipient's cached destinations, else FALLBACK_FORWARD. */
async function fallbackTargets(env: Env, rcpt: string): Promise<{ targets: string[]; source: "cache" | "fallback" | "none" }> {
  try {
    const cached = env.ROUTES ? await env.ROUTES.get(routeKey(rcpt)) : null;
    const list = cached ? (JSON.parse(cached) as unknown) : null;
    if (Array.isArray(list) && list.length && list.every((x) => typeof x === "string"))
      return { targets: list as string[], source: "cache" };
  } catch (err) {
    console.error(JSON.stringify({ msg: "route cache read failed", err: String(err) }));
  }
  const f = fallbackFor(env.FALLBACK_FORWARD, rcpt);
  return f ? { targets: [f], source: "fallback" } : { targets: [], source: "none" };
}

async function alert(env: Env, fetchImpl: typeof fetch, body: Record<string, unknown>) {
  if (!env.ALERT_WEBHOOK) return;
  try {
    await fetchImpl(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "worker.fallback", at: new Date().toISOString(), ...body }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "alert webhook failed", err: String(err) }));
  }
}

function toBase64(raw: Uint8Array) {
  let s = "";
  for (let i = 0; i < raw.length; i += 0x8000) s += String.fromCharCode(...raw.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fallback(message: EmailMessageLike, raw: Uint8Array, env: Env, reason: string, fetchImpl: typeof fetch): Promise<Outcome> {
  const { targets, source } =
    env.FALLBACK_MODE === "reject" ? { targets: [], source: "none" as const } : await fallbackTargets(env, message.to);
  let ok = 0;
  for (const to of targets) {
    try {
      await message.forward(to);
      ok++;
    } catch (err) {
      console.error(JSON.stringify({ msg: "fallback forward failed", to, err: String(err) }));
    }
  }
  let queued = false;
  if (ok) {
    // Forwarded, so the sender will not retry: queue a copy so the app still stores it once it is back.
    if (env.RETRY_QUEUE && raw.byteLength <= MAX_QUEUED_RAW) {
      try {
        await env.RETRY_QUEUE.send({ from: message.from, to: message.to, raw_base64: toBase64(raw), received_at: Date.now() });
        queued = true;
      } catch (err) {
        console.error(JSON.stringify({ msg: "retry queue send failed", err: String(err) }));
      }
    }
  } else {
    // Nowhere to forward it: a temporary error makes the sending server retry later instead of losing the mail.
    message.setReject("Temporary failure, please try again later");
  }
  const outcome: Outcome = ok ? "fallback_forwarded" : "temp_rejected";
  console.warn(JSON.stringify({ msg: "fallback used", to: message.to, outcome, source, forwarded: ok, queued }));
  await alert(env, fetchImpl, { to: message.to, outcome, source, queued, reason: reason.slice(0, 300) });
  return outcome;
}

/**
 * RETRY_QUEUE consumer: replays mail forwarded by the fallback to /ingest so the app stores it. The app's decision is
 * ignored (the mail was already forwarded); the app deduplicates by Message-ID. Failures are retried with back-off.
 */
export async function handleRetryBatch(batch: QueueBatchLike, env: Env, fetchImpl: typeof fetch = fetch): Promise<void> {
  for (const m of batch.messages) {
    const body = m.body as Partial<RetryMessage>;
    if (!body?.raw_base64 || !body.to || !body.from) {
      m.ack();
      continue;
    }
    try {
      const raw = Uint8Array.from(atob(body.raw_base64), (c) => c.charCodeAt(0));
      await postIngest(env, body.from, body.to, raw, fetchImpl, 15_000);
      m.ack();
    } catch (err) {
      console.error(JSON.stringify({ msg: "replay to app failed", to: body.to, attempts: m.attempts, err: String(err) }));
      // A 4xx (other than 429) will not get better by retrying: the mail was forwarded already, drop the copy.
      if (/HTTP 4(?!29)\d\d/.test(String(err))) m.ack();
      else m.retry({ delaySeconds: Math.min(3600, 60 * 2 ** Math.min(m.attempts, 6)) });
    }
  }
}

export default {
  async email(message: EmailMessageLike, env: Env): Promise<void> {
    // Only resolvable inside workerd; loaded lazily so the module stays testable in Node.
    const mod = (await import("cloudflare:email" as string).catch(() => null)) as {
      EmailMessage: new (from: string, to: string, raw: string) => unknown;
    } | null;
    await handleEmail(message, env, fetch, mod ? (from, to, raw) => new mod.EmailMessage(from, to, raw) : undefined);
  },
  async queue(batch: QueueBatchLike, env: Env): Promise<void> {
    await handleRetryBatch(batch, env);
  },
};
