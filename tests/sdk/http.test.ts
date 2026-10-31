import { describe, expect, it } from "vitest";
import { ThrowawayMail, ThrowawayMailError } from "../../sdk/src/index.js";

describe("SDK: transport", () => {
  it("sends the bearer key and handles non-JSON errors and Retry-After", async () => {
    let seen: Headers | undefined;
    const tm = new ThrowawayMail({
      baseUrl: "https://tm.example/",
      apiKey: "tm_abc",
      fetch: async (url, init) => {
        seen = new Headers(init.headers);
        expect(url).toBe("https://tm.example/v1/categories");
        return new Response("slow down", { status: 429, headers: { "retry-after": "12" } });
      },
    });
    const err = await tm.categories.list().catch((e) => e);
    expect(seen?.get("authorization")).toBe("Bearer tm_abc");
    expect(err).toBeInstanceOf(ThrowawayMailError);
    expect(err).toMatchObject({ status: 429, code: "http_429", retryAfter: 12, message: "slow down" });
  });

  it("times out and honours AbortSignal", async () => {
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    const tm = new ThrowawayMail({ baseUrl: "https://tm.example", apiKey: "k", fetch: hang, timeoutMs: 50 });
    await expect(tm.categories.list()).rejects.toMatchObject({ code: "timeout", status: 0 });
    const ctl = new AbortController();
    const p = tm.categories.list({ signal: ctl.signal, timeoutMs: 0 });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});
