/**
 * Throwaway Mail — Cloudflare Email Worker.
 * Receives every mail of every managed domain (catch-all rule), hands it to the app, and applies the app's decision:
 *   forward → message.forward(each of forward_to_all, or forward_to)   reject → message.setReject()   store_only → nothing
 * If the app is unreachable / errors / times out, the mail is forwarded to FALLBACK_FORWARD (if set).
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

export interface Env {
  APP_URL: string;
  INGEST_SECRET: string;
  FALLBACK_FORWARD?: string;
  INGEST_TIMEOUT_MS?: string;
}

interface Decision {
  action: "forward" | "store_only" | "reject";
  forward_to?: string;
  forward_to_all?: string[];
  reason?: string;
}

export type Outcome = "forwarded" | "stored" | "rejected" | "fallback_forwarded" | "temp_rejected";

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

export async function handleEmail(message: EmailMessageLike, env: Env, fetchImpl: typeof fetch = fetch): Promise<Outcome> {
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const ts = String(Math.floor(Date.now() / 1000));
  const timeout = Number(env.INGEST_TIMEOUT_MS || 5000);

  let decision: Decision;
  try {
    const signature = await sign(env.INGEST_SECRET, `${ts}\n${message.from}\n${message.to}\n`, raw);
    const res = await fetchImpl(`${env.APP_URL.replace(/\/$/, "")}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-tm-timestamp": ts,
        "x-tm-signature": signature,
        "x-tm-envelope-from": message.from,
        "x-tm-envelope-to": message.to,
      },
      body: raw,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`app answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    decision = (await res.json()) as Decision;
  } catch (err) {
    console.error(JSON.stringify({ msg: "ingest failed", to: message.to, err: String(err) }));
    return fallback(message, env);
  }

  switch (decision.action) {
    case "forward":
      {
        const targets = decision.forward_to_all?.length ? decision.forward_to_all : decision.forward_to ? [decision.forward_to] : [];
        let ok = 0;
        for (const to of targets) {
          try {
            await message.forward(to);
            ok++;
          } catch (err) {
            // Stored in the app already; a forwarding failure (e.g. destination unverified) must not bounce the mail.
            console.error(JSON.stringify({ msg: "forward failed", to, err: String(err) }));
          }
        }
        return ok ? "forwarded" : "stored";
      }
    case "reject":
      message.setReject(decision.reason === "unknown_recipient" || decision.reason === "unknown_domain" ? "Unknown recipient" : "Recipient not accepting mail");
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

async function fallback(message: EmailMessageLike, env: Env): Promise<Outcome> {
  const target = fallbackFor(env.FALLBACK_FORWARD, message.to);
  if (target) {
    try {
      await message.forward(target);
      return "fallback_forwarded";
    } catch (err) {
      console.error(JSON.stringify({ msg: "fallback forward failed", err: String(err) }));
    }
  }
  // Nothing else we can do: reject so the sender gets a bounce instead of silent loss.
  message.setReject("Temporary failure, please try again later");
  return "temp_rejected";
}

export default {
  async email(message: EmailMessageLike, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
};
