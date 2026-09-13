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
