import { ThrowawayMailError } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the client's default timeout for this call; 0 disables it. */
  timeoutMs?: number;
}

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs: number;
  userAgent?: string;
}

interface Call extends RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Query;
  body?: unknown;
  accept?: string;
}

export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  url(path: string, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) qs.append(k, String(v));
    const s = qs.toString();
    return `${this.config.baseUrl}${path}${s ? `?${s}` : ""}`;
  }

  /** Performs the call and returns the raw Response once headers arrived (2xx only). */
  async raw(call: Call): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.config.apiKey}`, accept: call.accept ?? "application/json" };
    if (this.config.userAgent) headers["user-agent"] = this.config.userAgent;
    if (call.body !== undefined) headers["content-type"] = "application/json";

    const timeoutMs = call.timeoutMs ?? this.config.timeoutMs;
    const ctl = new AbortController();
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), ctl.abort()), timeoutMs) : undefined;
    const onAbort = () => ctl.abort();
    if (call.signal?.aborted) ctl.abort();
    else call.signal?.addEventListener("abort", onAbort, { once: true });

    let res: Response;
    try {
      res = await this.config.fetch(this.url(call.path, call.query), {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: ctl.signal,
      });
    } catch (err) {
      if (timedOut) throw new ThrowawayMailError(0, "timeout", `Request timed out after ${timeoutMs} ms`, undefined, null, { cause: err });
      if (call.signal?.aborted) throw new ThrowawayMailError(0, "aborted", "Request aborted", undefined, null, { cause: err });
      throw new ThrowawayMailError(0, "network_error", err instanceof Error ? err.message : String(err), undefined, null, { cause: err });
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onAbort);
    }
    if (!res.ok) throw await toError(res);
    return res;
  }

  async json<T>(call: Call): Promise<T> {
    const res = await this.raw(call);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string, query?: Query, opts?: RequestOptions) {
    return this.json<T>({ method: "GET", path, query, ...opts });
  }
  post<T>(path: string, body: unknown = {}, opts?: RequestOptions) {
    return this.json<T>({ method: "POST", path, body, ...opts });
  }
  patch<T>(path: string, body: unknown, opts?: RequestOptions) {
    return this.json<T>({ method: "PATCH", path, body, ...opts });
  }
  delete<T>(path: string, opts?: RequestOptions) {
    return this.json<T>({ method: "DELETE", path, ...opts });
  }
}

async function toError(res: Response): Promise<ThrowawayMailError> {
  const retry = res.headers.get("retry-after");
  const retryAfter = retry && /^\d+$/.test(retry) ? Number(retry) : null;
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* body unreadable */
  }
  try {
    const e = (JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } }).error;
    if (e) return new ThrowawayMailError(res.status, e.code ?? `http_${res.status}`, e.message ?? res.statusText, e.details, retryAfter);
  } catch {
    /* not JSON */
  }
  return new ThrowawayMailError(
    res.status,
    `http_${res.status}`,
    text.slice(0, 200) || res.statusText || `HTTP ${res.status}`,
    undefined,
    retryAfter,
  );
}

/** `encodeURIComponent` for path segments. */
export const seg = (id: string) => encodeURIComponent(id);

/** Drops keys whose value is `undefined` so optional params are not sent. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
