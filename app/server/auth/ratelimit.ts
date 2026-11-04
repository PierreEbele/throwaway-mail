/** Fixed-window in-memory rate limiter (single process, which is all a 1 GB VPS needs). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private limit: number,
    private windowMs = 60_000,
  ) {}

  hit(key: string, now = Date.now()): { ok: boolean; retryAfter: number; remaining: number } {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) this.sweep(now);
    }
    w.count++;
    const remaining = Math.max(0, this.limit - w.count);
    if (w.count > this.limit) return { ok: false, retryAfter: Math.ceil((w.start + this.windowMs - now) / 1000), remaining };
    return { ok: true, retryAfter: 0, remaining };
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/** Sliding-window limiter: at most `limit` events in any `windowMs` span. Checking and recording are separate. */
export class SlidingWindowLimiter {
  private events = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  private live(key: string, now: number): number[] {
    const list = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.events.set(key, list);
    else this.events.delete(key);
    return list;
  }

  /** Seconds until one more event is allowed (0 when allowed now). */
  retryAfter(key: string, now: number): number {
    const list = this.live(key, now);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.limit]! + this.windowMs - now) / 1000));
  }

  record(key: string, now: number) {
    const list = this.live(key, now);
    list.push(now);
    this.events.set(key, list);
    if (this.events.size > 50_000) for (const k of [...this.events.keys()]) this.live(k, now);
  }

  /** Checks, then records when allowed. Returns the wait in seconds (0 = allowed). */
  hit(key: string, now: number): number {
    const wait = this.retryAfter(key, now);
    if (!wait) this.record(key, now);
    return wait;
  }

  reset(key: string) {
    this.events.delete(key);
  }
}

export interface AuthLimitOptions {
  /** Requests per IP to login-like endpoints within `ipWindowMs`. */
  ipLimit: number;
  ipWindowMs: number;
  /** Failed attempts per account (e-mail, user or invite) before it is locked for the rest of `accountWindowMs`. */
  accountFailures: number;
  accountWindowMs: number;
}

/** Budgets of login, setup, invite acceptance and two-factor endpoints: per IP (every request) and per account (failures). */
export class AuthLimits {
  readonly ip: SlidingWindowLimiter;
  readonly account: SlidingWindowLimiter;
  constructor(readonly options: AuthLimitOptions) {
    this.ip = new SlidingWindowLimiter(options.ipLimit, options.ipWindowMs);
    this.account = new SlidingWindowLimiter(options.accountFailures, options.accountWindowMs);
  }
}
