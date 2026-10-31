import { HttpClient, type FetchLike } from "./http.js";
import { parseSse } from "./sse.js";
import { Account } from "./resources/account.js";
import { Addresses } from "./resources/addresses.js";
import { Categories } from "./resources/categories.js";
import { Messages } from "./resources/messages.js";
import { Destinations, Directories, Notifications, SmartFolders } from "./resources/misc.js";
import type { ApiEvent } from "./types.js";

export interface ThrowawayMailOptions {
  /** e.g. `https://mail-app.example.com` (no trailing `/v1`). */
  baseUrl: string;
  /** API key, `tm_…`. */
  apiKey: string;
  /** Custom fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout. Default 30000 ms; 0 disables it. Long-polls extend it automatically. */
  timeoutMs?: number;
  userAgent?: string;
}

export interface EventsOptions {
  signal?: AbortSignal;
  /** Also yield the server's `ready` and `ping` keep-alive events. */
  includeKeepAlive?: boolean;
}

export type StreamEvent = ApiEvent | { type: "ready" } | { type: "ping"; at: number };

export class ThrowawayMail {
  readonly addresses: Addresses;
  readonly messages: Messages;
  readonly categories: Categories;
  readonly smartFolders: SmartFolders;
  readonly directories: Directories;
  readonly destinations: Destinations;
  readonly notifications: Notifications;
  readonly account: Account;
  private readonly http: HttpClient;

  constructor(opts: ThrowawayMailOptions) {
    if (!opts.baseUrl) throw new TypeError("baseUrl is required");
    if (!opts.apiKey) throw new TypeError("apiKey is required");
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new TypeError("No fetch implementation available; pass options.fetch");
    this.http = new HttpClient({
      baseUrl: opts.baseUrl.replace(/\/+$/, ""),
      apiKey: opts.apiKey,
      fetch: opts.fetch ?? ((input, init) => f(input, init)),
      timeoutMs: opts.timeoutMs ?? 30_000,
      userAgent: opts.userAgent,
    });
    this.addresses = new Addresses(this.http);
    this.messages = new Messages(this.http);
    this.categories = new Categories(this.http);
    this.smartFolders = new SmartFolders(this.http);
    this.directories = new Directories(this.http);
    this.destinations = new Destinations(this.http);
    this.notifications = new Notifications(this.http);
    this.account = new Account(this.http);
  }

  /**
   * Live events from `GET /v1/events`. The iterator ends when the server closes the stream or
   * `signal` aborts; breaking out of a `for await` loop closes the connection. No auto-reconnect.
   */
  async *events(opts: EventsOptions = {}): AsyncGenerator<StreamEvent> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (opts.signal?.aborted) return;
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.http.raw({ method: "GET", path: "/v1/events", accept: "text/event-stream", signal: ctl.signal, timeoutMs: 0 });
      if (!res.body) return;
      try {
        for await (const m of parseSse(res.body)) {
          if (m.event === "ready" || m.event === "ping") {
            if (opts.includeKeepAlive) yield m.event === "ready" ? { type: "ready" } : { type: "ping", at: Number(m.data) };
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(m.data);
          } catch {
            continue;
          }
          if (parsed && typeof parsed === "object" && "type" in parsed) yield parsed as ApiEvent;
        }
      } catch (err) {
        if (ctl.signal.aborted) return;
        throw err;
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      ctl.abort();
    }
  }
}
