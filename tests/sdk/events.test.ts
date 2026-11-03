import { describe, expect, it } from "vitest";
import { parseSse, ThrowawayMailError, type StreamEvent } from "../../sdk/src/index.js";
import { ingest, simpleEml } from "../helpers.js";
import { sdkFixture } from "./setup.js";

function streamOf(...chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("SDK: SSE", () => {
  it("parses events split across chunks, CRLF, comments and multi-line data", async () => {
    const out = [];
    for await (const m of parseSse(
      streamOf("event: a\r", '\ndata: {"x":', "1}\r\n\r\n: comment\n\ndata: l1\ndata: l2\nid: 7\n\n", "data: tail"),
    ))
      out.push(m);
    expect(out).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "message", data: "l1\nl2", id: "7" },
    ]);
  });

  it("events() yields message.received from the live stream", async () => {
    const { t, tm } = await sdkFixture();
    const a = await tm.addresses.create({ siteName: "Live", localPart: "live1" });
    const ctl = new AbortController();
    const got: StreamEvent[] = [];
    const it = tm.events({ signal: ctl.signal, includeKeepAlive: true });
    const first = await it.next();
    expect(first.value).toEqual({ type: "ready" });
    await ingest(t, a.email, simpleEml({ subject: "Ping", text: "code 551203" }));
    for await (const e of it) {
      got.push(e);
      if (e.type === "message.received") break;
    }
    const msg = got.find((e) => e.type === "message.received");
    expect(msg).toMatchObject({ type: "message.received", address_id: a.id, subject: "Ping", has_code: true });
    ctl.abort();
  });

  it("events() surfaces auth errors", async () => {
    const { t } = await sdkFixture();
    const { ThrowawayMail } = await import("../../sdk/src/index.js");
    const bad = new ThrowawayMail({
      baseUrl: "http://x",
      apiKey: "tm_invalid",
      fetch: (u, i) => Promise.resolve(t.app.request(new URL(u).pathname, i)),
    });
    const err = await bad
      .events()
      .next()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ThrowawayMailError);
    expect(err.status).toBe(401);
  });
});
