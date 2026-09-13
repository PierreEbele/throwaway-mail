import { describe, expect, it, vi } from "vitest";
import { handleEmail, type EmailMessageLike, type Env } from "../../worker/src/index.js";
import { ingestSignature } from "../../app/server/routes/ingest.js";
import { addDomain, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";

function fakeMessage(to: string, raw: string) {
  const m = {
    from: "sender@example.com",
    to,
    rawSize: raw.length,
    raw: new Response(raw).body!,
    rejected: null as string | null,
    forwardedTo: null as string | null,
    setReject(reason: string) {
      m.rejected = reason;
    },
    async forward(rcpt: string) {
      m.forwardedTo = rcpt;
    },
  };
  return m satisfies EmailMessageLike;
}

const env: Env = { APP_URL: "https://app.example", INGEST_SECRET: "test-ingest-secret-0123456789", FALLBACK_FORWARD: "fallback@me.example" };

describe("email worker", () => {
  it("signs requests the app accepts and applies its decisions end to end", async () => {
    const t = makeTestApp();
    const admin = await setupAdmin(t);
    await addDomain(admin);
    const a = (await admin.post("/v1/addresses", { site_name: "S" })).json;
    const appFetch = ((url: string, init: RequestInit) => t.app.request(new URL(url).pathname, init)) as unknown as typeof fetch;

    const ok = fakeMessage(a.email, simpleEml({ text: "Your code is 123456" }));
    expect(await handleEmail(ok, env, appFetch)).toBe("stored");
    expect(ok.rejected).toBeNull();

    const unknown = fakeMessage("nobody@mail.example.test", simpleEml({ text: "x" }));
    expect(await handleEmail(unknown, env, appFetch)).toBe("rejected");
    expect(unknown.rejected).toBe("Unknown recipient");

    const d = (await admin.post("/v1/destinations", { email: "me@personal.example" })).json.destination;
    await admin.post(`/v1/destinations/${d.id}/refresh`);
    await admin.patch(`/v1/addresses/${a.id}`, { forward_enabled: true, destination_id: d.id });
    const fwd = fakeMessage(a.email, simpleEml({ text: "x" }));
    expect(await handleEmail(fwd, env, appFetch)).toBe("forwarded");
    expect(fwd.forwardedTo).toBe("me@personal.example");
  });

  it("uses the same signature format as the app", async () => {
    const fetchSpy = vi.fn(async (_u: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      const body = new Uint8Array(init.body as Uint8Array);
      const expected = ingestSignature(env.INGEST_SECRET, h.get("x-tm-timestamp")!, h.get("x-tm-envelope-from")!, h.get("x-tm-envelope-to")!, body);
      expect(h.get("x-tm-signature")).toBe(expected);
      return Response.json({ action: "store_only" });
    });
    await handleEmail(fakeMessage("a@b.test", "Subject: x\r\n\r\nhello"), env, fetchSpy as unknown as typeof fetch);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("falls back to FALLBACK_FORWARD when the app is down or errors", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const m1 = fakeMessage("a@b.test", "x");
    expect(await handleEmail(m1, env, down)).toBe("fallback_forwarded");
    expect(m1.forwardedTo).toBe("fallback@me.example");

    const err500 = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const m2 = fakeMessage("a@b.test", "x");
    expect(await handleEmail(m2, env, err500)).toBe("fallback_forwarded");
  });

  it("times out after INGEST_TIMEOUT_MS", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const m = fakeMessage("a@b.test", "x");
    const start = Date.now();
    expect(await handleEmail(m, { ...env, INGEST_TIMEOUT_MS: "100" }, hang)).toBe("fallback_forwarded");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("temp-rejects when there is no fallback configured", async () => {
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const m = fakeMessage("a@b.test", "x");
    expect(await handleEmail(m, { ...env, FALLBACK_FORWARD: "" }, down)).toBe("temp_rejected");
    expect(m.rejected).toMatch(/Temporary/);
  });
});
