/** Error thrown for any non-2xx API response, network failure or timeout. */
export class ThrowawayMailError extends Error {
  override readonly name = "ThrowawayMailError";
  /** HTTP status; 0 for network errors and timeouts. */
  readonly status: number;
  /** API error code such as `not_found` or `bad_request`; `network_error` / `timeout` / `aborted` client-side. */
  readonly code: string;
  readonly details: unknown;
  /** Seconds from the `Retry-After` header, when the server sent one (429). */
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, details?: unknown, retryAfter: number | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}
