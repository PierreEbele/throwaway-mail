import { like } from "drizzle-orm";
import type { Deps } from "../context.js";
import { messages } from "../db/schema.js";
import { randomString } from "../lib/crypto.js";
import type { SmtpSettings } from "./mailbox/types.js";
import { metrics } from "./metrics.js";
import { notifyAdmins } from "./notify.js";
import { getState, setState } from "./state.js";

/**
 * End-to-end probe: every `interval_minutes` a test mail is sent through PROBE_SMTP_URL to an address of this
 * instance; it must be stored (i.e. went through MX → Worker / IMAP → ingest) within `timeout_minutes`.
 * The probe is driven by tick() (called every minute), so tests drive it with an injected clock and SMTP fake.
 */
export interface ProbeConfig {
  enabled: boolean;
  address: string;
  interval_minutes: number;
  timeout_minutes: number;
}

export interface ProbeState {
  pending: { token: string; sent_at: number } | null;
  last_run_at: number | null;
  last_ok: boolean | null;
  last_error: string | null;
  last_success_at: number | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
}

const CONFIG_KEY = "probe.config";
const STATE_KEY = "probe.state";
export const PROBE_SUBJECT = "Throwaway Mail probe";

const EMPTY: ProbeState = {
  pending: null,
  last_run_at: null,
  last_ok: null,
  last_error: null,
  last_success_at: null,
  last_latency_ms: null,
  consecutive_failures: 0,
};

export function probeConfig(deps: Pick<Deps, "db">): ProbeConfig {
  return getState<ProbeConfig>(deps, CONFIG_KEY) ?? { enabled: false, address: "", interval_minutes: 60, timeout_minutes: 10 };
}

export function saveProbeConfig(deps: Pick<Deps, "db" | "now">, c: ProbeConfig) {
  setState(deps, CONFIG_KEY, c);
  // A new address or interval starts from a clean slate (no pending probe for the old address).
  setState(deps, STATE_KEY, { ...probeState(deps), pending: null });
}

function probeState(deps: Pick<Deps, "db">): ProbeState {
  return { ...EMPTY, ...getState<ProbeState>(deps, STATE_KEY) };
}

export function probeStatus(deps: Pick<Deps, "db" | "config">) {
  const c = probeConfig(deps);
  const s = probeState(deps);
  return {
    ...c,
    transport_configured: !!deps.config.PROBE_SMTP_URL,
    enabled: c.enabled && !!deps.config.PROBE_SMTP_URL && !!c.address,
    ...s,
  };
}

/** smtp://user:pass@host:587 (STARTTLS), smtps://user:pass@host:465 (TLS); ?insecure=1 on smtp:// for no TLS at all. */
export function parseSmtpUrl(url: string): SmtpSettings {
  const u = new URL(url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("PROBE_SMTP_URL must start with smtp:// or smtps://");
  const tls = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: Number(u.port || (tls ? 465 : 587)),
    security: tls ? "tls" : u.searchParams.get("insecure") === "1" ? "none" : "starttls",
    user: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
  };
}

function probeMail(from: string, to: string, token: string, now: number) {
  return [
    `From: Throwaway Mail probe <${from}>`,
    `To: <${to}>`,
    `Subject: ${PROBE_SUBJECT} ${token}`,
    `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <probe-${token}@throwaway-mail.invalid>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "End-to-end delivery test sent by Throwaway Mail. It is deleted automatically once received.",
    "",
  ].join("\r\n");
}

type Outcome = "idle" | "sent" | "waiting" | "ok" | "failed";

async function fail(deps: Deps, s: ProbeState, error: string, now: number): Promise<Outcome> {
  const next: ProbeState = {
    ...s,
    pending: null,
    last_run_at: now,
    last_ok: false,
    last_error: error,
    consecutive_failures: s.consecutive_failures + 1,
  };
  setState(deps, STATE_KEY, next);
  metrics.probes.inc({ result: "error" });
  metrics.job("probe", false, error);
  deps.logger.warn("end-to-end probe failed", { err: error });
  // Alert once per outage, not at every interval.
  if (next.consecutive_failures === 1) {
    await notifyAdmins(deps, {
      title: "Mail delivery probe failed",
      body: error,
      url: `${deps.config.APP_URL.replace(/\/$/, "")}/admin`,
    });
  }
  return "failed";
}

/** One step of the probe state machine. */
export async function probeTick(deps: Deps): Promise<Outcome> {
  const c = probeConfig(deps);
  if (!c.enabled || !c.address || !deps.config.PROBE_SMTP_URL) return "idle";
  const s = probeState(deps);
  const now = deps.now();

  if (s.pending) {
    const marker = `%${s.pending.token}%`;
    const hit = deps.db
      .select({ id: messages.id, receivedAt: messages.receivedAt })
      .from(messages)
      .where(like(messages.subject, marker))
      .get();
    if (hit) {
      deps.db.delete(messages).where(like(messages.subject, marker)).run();
      const recovered = s.consecutive_failures > 0;
      setState(deps, STATE_KEY, {
        ...s,
        pending: null,
        last_run_at: now,
        last_ok: true,
        last_error: null,
        last_success_at: now,
        last_latency_ms: Math.max(0, hit.receivedAt - s.pending.sent_at),
        consecutive_failures: 0,
      } satisfies ProbeState);
      metrics.probes.inc({ result: "ok" });
      metrics.job("probe", true, `delivered in ${Math.round((hit.receivedAt - s.pending.sent_at) / 1000)} s`);
      if (recovered)
        await notifyAdmins(deps, { title: "Mail delivery probe recovered", body: `Probe mail to ${c.address} received again.` });
      return "ok";
    }
    if (now - s.pending.sent_at > c.timeout_minutes * 60_000) {
      return fail(deps, s, `probe mail to ${c.address} not received within ${c.timeout_minutes} min`, now);
    }
    return "waiting";
  }

  if (s.last_run_at !== null && now - s.last_run_at < c.interval_minutes * 60_000) return "idle";
  const token = randomString(20).toLowerCase();
  const from = deps.config.PROBE_FROM || `probe@${new URL(deps.config.APP_URL).hostname}`;
  try {
    const settings = parseSmtpUrl(deps.config.PROBE_SMTP_URL);
    await deps.mail.smtp.send(settings, { from, to: [c.address] }, Buffer.from(probeMail(from, c.address, token, now)));
  } catch (e) {
    return fail(deps, s, `sending the probe mail failed: ${(e as Error).message.slice(0, 300)}`, now);
  }
  setState(deps, STATE_KEY, { ...s, pending: { token, sent_at: now }, last_run_at: now } satisfies ProbeState);
  return "sent";
}
