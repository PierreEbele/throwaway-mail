import crypto from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers.js";
import { subscriptionOf, vapidKeys, webPushRequest } from "../../app/server/services/webpush.js";
import { getState } from "../../app/server/services/state.js";
import type { NotifyTarget } from "../../app/server/db/schema.js";

const ece = createRequire(import.meta.url)("http_ece") as {
  decrypt: (b: Buffer, o: { version: string; privateKey: crypto.ECDH; authSecret: Buffer }) => Buffer;
};
const APP_SECRET = "an-app-secret-of-at-least-32-characters!";

function browser() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const target = {
    id: "ntf_test",
    kind: "webpush",
    url: "https://push.example.com/send/abc",
    token: JSON.stringify({ p256dh: ecdh.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") }),
  } as NotifyTarget;
  return { ecdh, authSecret, target };
}

describe("web push", () => {
  it("encrypts the stored VAPID private key with APP_SECRET and reuses the pair", () => {
    const { deps } = makeTestApp({ APP_SECRET });
    const k = vapidKeys(deps);
    expect(Buffer.from(k.publicKey, "base64url")).toHaveLength(65);
    const stored = getState<{ publicKey: string; privateKey: string }>(deps, "webpush.vapid")!;
    expect(stored.publicKey).toBe(k.publicKey);
    expect(stored.privateKey.startsWith("v1:")).toBe(true);
    expect(stored.privateKey).not.toContain(k.privateKey);
    expect(vapidKeys(deps)).toEqual(k);
  });

  it("stores the key in clear without APP_SECRET; the subject follows APP_URL", () => {
    const { deps } = makeTestApp();
    const k = vapidKeys(deps);
    expect(getState<{ privateKey: string }>(deps, "webpush.vapid")!.privateKey).toBe(k.privateKey);
    expect(k.subject).toBe("mailto:admin@localhost");
    expect(vapidKeys(makeTestApp({ APP_URL: "https://mail.example.org/app" }).deps).subject).toBe("https://mail.example.org");
    expect(vapidKeys(makeTestApp({ VAPID_SUBJECT: "mailto:ops@example.org" }).deps).subject).toBe("mailto:ops@example.org");
  });

  it("refuses incomplete subscriptions", () => {
    const { target } = browser();
    expect(subscriptionOf(target).endpoint).toBe(target.url);
    expect(() => subscriptionOf({ ...target, url: null })).toThrow("Incomplete");
    expect(() => subscriptionOf({ ...target, token: JSON.stringify({ p256dh: "x" }) })).toThrow("Incomplete");
    expect(() => subscriptionOf({ ...target, token: null })).toThrow("Incomplete");
  });

  it("builds an encrypted request with normal urgency for ordinary events", () => {
    const { deps } = makeTestApp();
    const b = browser();
    const payload = { title: "New mail", body: "Hello", url: "http://localhost:3000/addresses/x" };
    const r = webPushRequest(deps, b.target, payload, false);
    expect(r.url).toBe(b.target.url);
    const h = r.init.headers as Record<string, string>;
    expect(h.Urgency).toBe("normal");
    expect(String(h.TTL)).toBe("900");
    expect(h.Authorization).toContain(`k=${vapidKeys(deps).publicKey}`);
    const plain = ece.decrypt(Buffer.from(r.init.body as Uint8Array), {
      version: "aes128gcm",
      privateKey: b.ecdh,
      authSecret: b.authSecret,
    });
    expect(JSON.parse(plain.toString())).toEqual(payload);
    expect((webPushRequest(deps, b.target, payload, true).init.headers as Record<string, string>).Urgency).toBe("high");
  });
});
