import { describe, expect, it } from "vitest";
import { handleEmail, handleRetryBatch, type Env, type RetryMessage, type RouteStore } from "../../worker/src/index.js";
import { addDomain, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";

function fakeMessage(to: string, raw: string) {
  const m = {
    from: "sender@example.com",
    to,
    rawSize: raw.length,
    raw: new Response(raw).body!,
    rejected: null as string | null,
    forwardedAll: [] as string[],
    setReject(reason: string) {
      m.rejected = reason;
    },
    async forward(rcpt: string) {
      if (rcpt === "broken@me.example") throw new Error("destination not verified");
      m.forwardedAll.push(rcpt);
    },
  };
  return m;
}

function memoryKv(): RouteStore & { data: Map<string, string>; puts: number } {
  const data = new Map<string, string>();
  const kv = {
    data,
    puts: 0,
    async get(k: string) {
      return data.get(k) ?? null;
    },
    async put(k: string, v: string) {
      kv.puts++;
      data.set(k, v);
    },
    async delete(k: string) {
      data.delete(k);
    },
  };
  return kv;
}

const base: Env = {
  APP_URL: "https://app.example",
  INGEST_SECRET: "test-ingest-secret-0123456789",
  FALLBACK_FORWARD: "fallback@me.example",
};
const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
const down = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("worker fallback", () => {
  it("caches the app's forward targets and reuses them while the app is down", async () => {
    const ROUTES = memoryKv();
    const env = { ...base, ROUTES };
    await handleEmail(fakeMessage("a@x.test", "x"), env, answer({ action: "forward", forward_to_all: ["b@me.example", "a@me.example"] }));
    await handleEmail(fakeMessage("A@X.test", "x"), env, answer({ action: "forward", forward_to_all: ["a@me.example", "b@me.example"] }));
    expect(ROUTES.puts).toBe(1); // unchanged routes are not rewritten

    const m = fakeMessage("a@x.test", "x");
    expect(await handleEmail(m, env, down)).toBe("fallback_forwarded");
    expect(m.forwardedAll).toEqual(["a@me.example", "b@me.example"]);

    // An address that stopped forwarding loses its cache entry and falls back to FALLBACK_FORWARD.
    await handleEmail(fakeMessage("a@x.test", "x"), env, answer({ action: "store_only" }));
    expect(ROUTES.data.size).toBe(0);
    const m2 = fakeMessage("a@x.test", "x");
    expect(await handleEmail(m2, env, down)).toBe("fallback_forwarded");
    expect(m2.forwardedAll).toEqual(["fallback@me.example"]);
  });

  it("queues forwarded mail for the app, alerts, and temp-rejects when nothing could be forwarded", async () => {
    const queued: RetryMessage[] = [];
    const alerts: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === "https://alerts.example/hook") {
        alerts.push(String(init.body));
        return new Response("ok");
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const env: Env = { ...base, RETRY_QUEUE: { send: async (b) => void queued.push(b) }, ALERT_WEBHOOK: "https://alerts.example/hook" };

    const m = fakeMessage("a@x.test", "Subject: hi\r\n\r\nbody");
    expect(await handleEmail(m, env, fetchImpl)).toBe("fallback_forwarded");
    expect(queued).toHaveLength(1);
    expect(atob(queued[0]!.raw_base64)).toBe("Subject: hi\r\n\r\nbody");
    expect(JSON.parse(alerts[0]!)).toMatchObject({
      type: "worker.fallback",
      outcome: "fallback_forwarded",
      source: "fallback",
      queued: true,
    });

    const broken = fakeMessage("a@x.test", "x");
    expect(await handleEmail(broken, { ...env, FALLBACK_FORWARD: "broken@me.example" }, fetchImpl)).toBe("temp_rejected");
    expect(broken.rejected).toMatch(/Temporary/);
    expect(queued).toHaveLength(1); // the sender retries: nothing to queue

    const strict = fakeMessage("a@x.test", "x");
    expect(await handleEmail(strict, { ...env, FALLBACK_MODE: "reject" }, fetchImpl)).toBe("temp_rejected");
    expect(strict.forwardedAll).toEqual([]);
  });

  it("replays queued mail to the app, which stores it", async () => {
    const t = makeTestApp();
    const admin = await setupAdmin(t);
    await addDomain(admin);
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json;
    const appFetch = ((url: string, init: RequestInit) => t.app.request(new URL(url).pathname, init)) as unknown as typeof fetch;

    const queued: RetryMessage[] = [];
    const m = fakeMessage(a.email, simpleEml({ text: "Your code is 424242" }));
    expect(await handleEmail(m, { ...base, RETRY_QUEUE: { send: async (b) => void queued.push(b) } }, down)).toBe("fallback_forwarded");

    const acked: number[] = [];
    const retried: number[] = [];
    const batch = (bodies: unknown[]) => ({
      messages: bodies.map((body, i) => ({ body, attempts: 1, ack: () => acked.push(i), retry: () => retried.push(i) })),
    });
    await handleRetryBatch(batch([queued[0]]), base, down);
    expect(retried).toEqual([0]);
    await handleRetryBatch(batch([queued[0], { nonsense: true }]), base, appFetch);
    expect(acked).toEqual([0, 1]);
    const msgs = (await admin.get(`/v1/addresses/${a.id}/messages`)).json;
    expect(JSON.stringify(msgs)).toContain("424242");
  });
});
