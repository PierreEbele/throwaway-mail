import { streamSSE } from "hono/streaming";
import type { ApiRouter } from "../lib/http.js";
import { scopeAllows } from "../auth/middleware.js";

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
      const scope = c.get("apiScope");
      c.header("x-accel-buffering", "no");
      return streamSSE(c, async (stream) => {
        const unsub = d.bus.subscribe(user.id, (e) => {
          // Address-restricted keys only get events about their addresses (no account-wide events).
          if (scope?.addressIds && !("address_id" in e && scopeAllows(scope, e.address_id))) return;
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
