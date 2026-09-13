import { streamSSE } from "hono/streaming";
import type { ApiRouter } from "../lib/http.js";

export function registerEvents(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/events",
      summary: "Server-sent events for the current user",
      description: "Events: message.received, address.created, address.updated, address.deleted, plus a ping every 25 s.",
      tags: ["events"],
      auth: "user",
    },
    (c) => {
      const d = c.get("deps");
      const user = c.get("user")!;
      c.header("x-accel-buffering", "no");
      return streamSSE(c, async (stream) => {
        const unsub = d.bus.subscribe(user.id, (e) => {
          stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
        });
        stream.onAbort(() => unsub());
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!stream.aborted && !stream.closed) {
          await stream.sleep(25_000);
          if (stream.aborted) break;
          await stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {});
        }
        unsub();
      });
    },
  );
}
