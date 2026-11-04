import { describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { webhookSignature } from "../../app/server/services/notify.js";
import { MAX_ATTEMPTS, PAUSE_AFTER, backoffMs, processWebhookOutbox } from "../../app/server/services/webhooks.js";
import { pauseExpired } from "../../app/server/services/reminders.js";

async function setup() {
  const t = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  let clock = Date.now();
  t.deps.now = () => clock;
  const advance = (ms: number) => (clock += ms);
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let status = 200;
  t.deps.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response("x", { status });
  }) as typeof fetch;
  const setStatus = (s: number) => (status = s);
  const flush = () => new Promise((r) => setTimeout(r, 20));
  const hook = async (events: string[]) =>
    (await user.post("/v1/notify-targets", { kind: "webhook", name: "n8n", url: "https://n8n.example.com/hook", events })).json.target;
  return { t, admin, user, calls, setStatus, flush, advance, hook };
}

describe("event webhooks", () => {
  it("signs a stable JSON payload for address.created and address.deleted", async () => {
    const { user, calls, flush, hook } = await setup();
    const target = await hook(["address.created", "address.deleted"]);
    const a = (await user.post("/v1/addresses", { site_name: "Shop", site_url: "shop.com" })).json.address;
    await flush();
    expect(calls).toHaveLength(1);
    const { headers, body } = calls[0]!;
    expect(headers["x-tm-event"]).toBe("address.created");
    expect(headers["x-tm-signature"]).toBe(webhookSignature(target.secret, headers["x-tm-timestamp"]!, body));
    const p = JSON.parse(body);
    expect(p).toMatchObject({
      type: "address.created",
      data: { address_id: a.id, address: a.email, site: "Shop", site_url: "https://shop.com" },
    });
    expect(p.id).toMatch(/^evt_/);
    expect(headers["x-tm-event-id"]).toBe(p.id);
    expect(typeof p.created_at).toBe("number");
    // Earlier payloads had the data fields at the top level: still there.
    expect(p.address_id).toBe(a.id);

    await user.del(`/v1/addresses/${a.id}`);
    await flush();
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ type: "address.deleted", data: { address_id: a.id } });
  });

  it("sends message.received, message.blocked and address.expired", async () => {
    const { t, user, calls, flush, hook } = await setup();
    await hook(["message.received", "message.blocked", "address.expired"]);
    const a = (await user.post("/v1/addresses", { site_name: "Shop" })).json.address;
    await ingest(t, a.email, simpleEml({ text: "hello", from: "x@shop.com" }));
    await user.patch(`/v1/addresses/${a.id}`, { status: "paused" });
    await ingest(t, a.email, simpleEml({ text: "buy", from: "x@spam.example" }), { from: "x@spam.example" });
    await user.patch(`/v1/addresses/${a.id}`, { status: "active" });
    await flush();
    expect(calls.map((c) => JSON.parse(c.body).type)).toEqual(["message.received", "message.blocked"]);
    expect(JSON.parse(calls[1]!.body).data).toMatchObject({ reason: "address_paused", address_id: a.id, from: "x@spam.example" });

    await user.patch(`/v1/addresses/${a.id}`, { expires_at: t.deps.now() - 1000 });
    pauseExpired(t.deps);
    await flush();
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ type: "address.expired", data: { address_id: a.id } });
  });

  it("retries with exponential backoff, gives up, then pauses the endpoint", async () => {
    const { user, calls, flush, hook, setStatus, advance, t } = await setup();
    const target = await hook(["address.created"]);
    setStatus(500);
    await user.post("/v1/addresses", { site_name: "One" });
    await flush();
    expect(calls).toHaveLength(1);
    let list = (await user.get(`/v1/notify-targets/${target.id}/deliveries`)).json.deliveries;
    expect(list[0]).toMatchObject({ status: "pending", attempts: 1, last_status: 500, last_error: "HTTP 500" });

    // Not due yet.
    expect(await processWebhookOutbox(t.deps)).toBe(0);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      advance(backoffMs(i));
      expect(await processWebhookOutbox(t.deps)).toBe(1);
    }
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    list = (await user.get(`/v1/notify-targets/${target.id}/deliveries`)).json.deliveries;
    expect(list[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);

    // Resend: same event id, delivered once the endpoint is back.
    setStatus(200);
    const r = (await user.post(`/v1/notify-targets/${target.id}/deliveries/${list[0].id}/resend`)).json;
    expect(r).toMatchObject({ ok: true, delivery: { status: "delivered", event_id: list[0].event_id } });
  });

  it("pauses after repeated failed deliveries and resumes on demand", async () => {
    const { user, calls, flush, hook, setStatus, advance, t } = await setup();
    const target = await hook(["address.created"]);
    setStatus(503);
    for (let n = 0; n < PAUSE_AFTER; n++) {
      await user.post("/v1/addresses", { site_name: `S${n}` });
      await flush();
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        advance(backoffMs(i));
        await processWebhookOutbox(t.deps);
      }
    }
    let got = (await user.get("/v1/notify-targets")).json.targets[0];
    expect(got.paused_at).not.toBeNull();
    expect(got.consecutive_failures).toBe(PAUSE_AFTER);
    const before = calls.length;
    await user.post("/v1/addresses", { site_name: "While paused" });
    await flush();
    expect(calls.length).toBe(before);

    setStatus(200);
    got = (await user.post(`/v1/notify-targets/${target.id}/resume`)).json.target;
    expect(got).toMatchObject({ paused_at: null, consecutive_failures: 0, enabled: true });
    expect((await user.post(`/v1/notify-targets/${target.id}/test`)).json).toEqual({ ok: true });
    expect(JSON.parse(calls.at(-1)!.body).data).toMatchObject({ test: true });
  });

  it("re-checks the URL at delivery time", async () => {
    const { t, user, calls, flush, hook } = await setup();
    const target = await hook(["address.created"]);
    t.deps.resolve = async () => ["10.0.0.7"];
    await user.post("/v1/addresses", { site_name: "Rebind" });
    await flush();
    expect(calls).toHaveLength(0);
    const list = (await user.get(`/v1/notify-targets/${target.id}/deliveries`)).json.deliveries;
    expect(list[0].last_error).toContain("private address");
  });
});
