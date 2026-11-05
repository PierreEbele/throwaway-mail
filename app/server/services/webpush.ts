import webpush from "web-push";
import type { Deps } from "../context.js";
import type { NotifyTarget } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { getState, setState } from "./state.js";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const STATE_KEY = "webpush.vapid";
const cache = new WeakMap<object, VapidKeys>();

/**
 * VAPID keys identifying this server to push services. From VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, otherwise
 * generated once and kept in system_state (the private key encrypted with APP_SECRET when it is set).
 */
export function vapidKeys(deps: Pick<Deps, "db" | "now" | "config">): VapidKeys {
  const cfg = deps.config;
  const subject = cfg.VAPID_SUBJECT ?? (cfg.APP_URL.startsWith("https://") ? new URL(cfg.APP_URL).origin : "mailto:admin@localhost");
  if (cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY) return { publicKey: cfg.VAPID_PUBLIC_KEY, privateKey: cfg.VAPID_PRIVATE_KEY, subject };
  const hit = cache.get(deps.db);
  if (hit) return { ...hit, subject };
  let stored = getState<{ publicKey: string; privateKey: string }>(deps, STATE_KEY);
  if (!stored) {
    const k = webpush.generateVAPIDKeys();
    stored = { publicKey: k.publicKey, privateKey: cfg.APP_SECRET ? encryptSecret(cfg.APP_SECRET, k.privateKey) : k.privateKey };
    setState(deps, STATE_KEY, stored);
  }
  const privateKey = stored.privateKey.startsWith("v1:") ? decryptSecret(cfg.APP_SECRET ?? "", stored.privateKey) : stored.privateKey;
  const keys = { publicKey: stored.publicKey, privateKey, subject };
  cache.set(deps.db, keys);
  return keys;
}

/** Push subscription keys are kept as JSON in the target's token column; the endpoint in url. */
export function subscriptionOf(t: NotifyTarget): webpush.PushSubscription {
  const keys = JSON.parse(t.token ?? "{}") as { p256dh?: string; auth?: string };
  if (!t.url || !keys.p256dh || !keys.auth) throw new Error("Incomplete push subscription");
  return { endpoint: t.url, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  /** Verification code: the service worker then offers a "Copy code" action. */
  code?: string;
  /** Notification actions the service worker shows (it handles "copy" and "open"). */
  actions?: { action: "copy" | "open"; title: string }[];
}

/** Payload of a push: a code notification gets "Copy code" and "Open" actions. */
export function pushPayload(e: { type: string; title: string; body: string; url?: string; data?: Record<string, unknown> }): PushPayload {
  const code = e.type === "code.received" && typeof e.data?.code === "string" ? e.data.code : undefined;
  return {
    title: e.title,
    body: e.body,
    url: e.url,
    tag: e.type === "code.received" ? "code" : undefined,
    ...(code
      ? {
          code,
          actions: [
            { action: "copy", title: "Copy code" },
            { action: "open", title: "Open" },
          ],
        }
      : {}),
  };
}

/** Encrypted Web Push request (RFC 8291) for one notification; sent with deps.fetch like the other targets. */
export function webPushRequest(
  deps: Pick<Deps, "db" | "now" | "config">,
  t: NotifyTarget,
  payload: PushPayload,
  urgent: boolean,
): { url: string; init: RequestInit } {
  const v = vapidKeys(deps);
  const r = webpush.generateRequestDetails(subscriptionOf(t), JSON.stringify(payload), {
    vapidDetails: v,
    TTL: 15 * 60,
    urgency: urgent ? "high" : "normal",
  });
  return { url: r.endpoint, init: { method: "POST", headers: r.headers as Record<string, string>, body: new Uint8Array(r.body) } };
}
