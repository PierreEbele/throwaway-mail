import crypto from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { webhookSignature } from "../../app/server/services/notify.js";
import { checkOutboundUrl, isPrivateHost, isPrivateIp } from "../../app/server/lib/outbound.js";

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.deps.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("ok");
  }) as typeof fetch;
  const flush = () => new Promise((r) => setTimeout(r, 20));
  return { t, admin, user, calls, flush };
}

describe("notifications", () => {
  it("detects private hosts", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.5",
      "172.20.0.1",
      "ha.local",
      "nas.lan",
      "homeassistant",
      "::1",
      "[fd00::1]",
    ])
      expect(isPrivateHost(h)).toBe(true);
    for (const h of ["ntfy.sh", "8.8.8.8", "172.32.0.1", "example.com"]) expect(isPrivateHost(h)).toBe(false);
    for (const ip of ["::ffff:10.0.0.1", "fd12::1", "0.0.0.0", "100.64.1.1"]) expect(isPrivateIp(ip)).toBe(true);
  });

  it("refuses public names that resolve to private addresses", async () => {
    const resolve = async (h: string) => (h === "rebind.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]);
    await expect(checkOutboundUrl("https://rebind.example.com/x", { resolve })).rejects.toThrow("private address");
    await expect(checkOutboundUrl("http://ok.example.com/x", { resolve, httpsOnly: true })).rejects.toThrow("https only");
    await expect(checkOutboundUrl("https://u:p@ok.example.com/", { resolve })).rejects.toThrow("credentials");
    expect((await checkOutboundUrl("https://ok.example.com/x", { resolve })).hostname).toBe("ok.example.com");
    expect((await checkOutboundUrl("http://10.0.0.5/", { resolve, allowPrivate: true })).hostname).toBe("10.0.0.5");
  });

  it("validates targets and keeps tokens write-only", async () => {
    const { admin, user } = await setup();
    expect((await user.post("/v1/notify-targets", { kind: "ntfy", name: "x", url: "http://192.168.1.2/topic" })).status).toBe(400);
    expect((await admin.post("/v1/notify-targets", { kind: "ntfy", name: "x", url: "http://192.168.1.2/topic" })).status).toBe(201);
    expect((await user.post("/v1/notify-targets", { kind: "telegram", name: "t" })).status).toBe(400);
    expect((await user.post("/v1/notify-targets", { kind: "ntfy", name: "x", url: "ftp://ntfy.sh/t" })).status).toBe(400);
    const t = (await user.post("/v1/notify-targets", { kind: "gotify", name: "g", url: "https://gotify.example.com", token: "SECRET" }))
      .json.target;
    expect(t).toMatchObject({ has_token: true });
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });

  it("pushes codes to ntfy, Telegram and signed webhooks", async () => {
    const { t, user, calls, flush } = await setup();
    await user.post("/v1/notify-targets", {
      kind: "ntfy",
      name: "phone",
      url: "https://ntfy.sh/my-topic",
      token: "tk",
      events: ["code.received"],
    });
    await user.post("/v1/notify-targets", { kind: "telegram", name: "tg", token: "123:abc", chat_id: "42", events: ["code.received"] });
    const hook = (
      await user.post("/v1/notify-targets", {
        kind: "webhook",
        name: "n8n",
        url: "https://n8n.example.com/hook",
        events: ["message.received", "code.received"],
      })
    ).json.target;
    const a = (await user.post("/v1/addresses", { site_name: "GitHub" })).json.address;

    await ingest(t, a.email, simpleEml({ subject: "Hi", text: "nothing here" }));
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["https://n8n.example.com/hook"]);

    calls.length = 0;
    await ingest(t, a.email, simpleEml({ subject: "Your code", text: "Your verification code is 482913" }));
    await flush();
    const ntfy = calls.find((c) => c.url === "https://ntfy.sh/my-topic")!;
    expect((ntfy.init.headers as any).title).toBe("Code 482913");
    expect((ntfy.init.headers as any).authorization).toBe("Bearer tk");
    const tg = calls.find((c) => c.url.startsWith("https://api.telegram.org/bot123:abc/"))!;
    expect(JSON.parse(tg.init.body as string)).toMatchObject({ chat_id: "42" });
    const wh = calls.filter((c) => c.url === "https://n8n.example.com/hook");
    expect(wh.map((c) => JSON.parse(c.init.body as string).type).sort()).toEqual(["code.received", "message.received"]);
    const h = wh[0]!.init.headers as Record<string, string>;
    expect(h["x-tm-signature"]).toBe(webhookSignature(hook.secret, h["x-tm-timestamp"]!, wh[0]!.init.body as string));
  });

  it("records failures and supports a test send", async () => {
    const { t, user } = await setup();
    t.deps.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const tg = (await user.post("/v1/notify-targets", { kind: "telegram", name: "tg", token: "1:a", chat_id: "1" })).json.target;
    expect((await user.post(`/v1/notify-targets/${tg.id}/test`)).json).toEqual({ ok: false, error: "HTTP 500" });
    expect((await user.get("/v1/notify-targets")).json.targets[0].last_error).toBe("HTTP 500");
  });
});

describe("Web Push", () => {
  // Decrypts RFC 8291 payloads the way a browser does (the library web-push itself relies on).
  const ece = createRequire(import.meta.url)("http_ece") as {
    decrypt(buf: Buffer, p: { version: string; privateKey: crypto.ECDH; authSecret: Buffer }): Buffer;
  };
  const browserKeys = () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const authSecret = crypto.randomBytes(16);
    return { ecdh, authSecret, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } };
  };

  it("registers a browser subscription and sends encrypted, VAPID-signed pushes", async () => {
    const { t, user, calls, flush } = await setup();
    const key = (await user.get("/v1/push/vapid-key")).json.public_key as string;
    expect(Buffer.from(key, "base64url")).toHaveLength(65);
    // The key pair is generated once and kept.
    expect((await user.get("/v1/push/vapid-key")).json.public_key).toBe(key);

    const b = browserKeys();
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: b.keys, name: "Android", events: ["code.received"] };
    expect((await user.post("/v1/push/subscriptions", { ...sub, endpoint: "http://fcm.googleapis.com/x" })).status).toBe(400);
    const target = (await user.post("/v1/push/subscriptions", sub)).json.target;
    expect(target).toMatchObject({ kind: "webpush", name: "Android", has_token: true, url: sub.endpoint });
    // Same endpoint again: updated, not duplicated.
    expect((await user.post("/v1/push/subscriptions", sub)).status).toBe(200);
    expect((await user.get("/v1/notify-targets")).json.targets).toHaveLength(1);

    const a = (await user.post("/v1/addresses", { site_name: "GitHub" })).json.address;
    await ingest(t, a.email, simpleEml({ subject: "Your code", text: "Your verification code is 482913" }));
    await flush();
    const push = calls.find((c) => c.url === sub.endpoint)!;
    const h = push.init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${key}$`));
    expect(h.Urgency).toBe("high");
    const plain = ece.decrypt(Buffer.from(push.init.body as Uint8Array), {
      version: "aes128gcm",
      privateKey: b.ecdh,
      authSecret: b.authSecret,
    });
    expect(JSON.parse(plain.toString())).toMatchObject({ title: "Code 482913", tag: "code" });
  });

  it("disables a subscription the push service reports as gone", async () => {
    const { t, user } = await setup();
    t.deps.fetch = (async () => new Response("gone", { status: 410 })) as typeof fetch;
    const target = (
      await user.post("/v1/push/subscriptions", {
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
        keys: browserKeys().keys,
      })
    ).json.target;
    expect((await user.post(`/v1/notify-targets/${target.id}/test`)).json).toEqual({ ok: false, error: "HTTP 410" });
    expect((await user.get("/v1/notify-targets")).json.targets[0].enabled).toBe(false);
  });

  it("uses the VAPID key pair from the environment when set", async () => {
    const t = makeTestApp({ VAPID_PUBLIC_KEY: "BPub", VAPID_PRIVATE_KEY: "priv" });
    const admin = await setupAdmin(t);
    expect((await admin.get("/v1/push/vapid-key")).json.public_key).toBe("BPub");
  });
});

describe("newsletters", () => {
  const news = (extra: string[] = []) =>
    [
      "From: News <news@shop.com>",
      "To: x@mail.example.test",
      "Subject: Deals",
      `Message-ID: <${Math.random()}@shop.com>`,
      "List-Unsubscribe: <https://shop.com/unsub?u=1>",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      ...extra,
      "",
      "Big deals",
    ].join("\r\n");

  it("unsubscribes in one click and can block future newsletters", async () => {
    const { t, user, calls } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "Shop", site_url: "shop.com" })).json.address;
    await ingest(t, a.email, news());
    const m = (await user.get(`/v1/addresses/${a.id}/messages`)).json.messages[0];
    expect(m).toMatchObject({ is_bulk: true, unsubscribe: { url: "https://shop.com/unsub?u=1", one_click: true } });
    const r = (await user.post(`/v1/messages/${m.id}/unsubscribe`, { block: true })).json;
    expect(r).toMatchObject({ done: true, blocked: true });
    expect(calls.at(-1)).toMatchObject({ url: "https://shop.com/unsub?u=1" });
    expect(calls.at(-1)!.init.body).toBe("List-Unsubscribe=One-Click");
    expect((await ingest(t, a.email, news())).json).toMatchObject({ action: "reject", reason: "promotional_blocked" });
    // a code still gets through
    expect((await ingest(t, a.email, news(["X-Extra: 1"]).replace("Big deals", "Your verification code is 552211"))).json.action).toBe(
      "store_only",
    );
  });

  it("flags look-alike senders", async () => {
    const { t, user } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "PayPal", site_url: "paypal.com" })).json.address;
    await ingest(t, a.email, simpleEml({ text: "verify your account", from: "PayPal <service@paypa1.com>" }));
    expect((await user.get(`/v1/addresses/${a.id}/messages`)).json.messages[0].auth_warning).toBe("lookalike");
  });
});
