import type { Ctx } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { HttpError } from "../lib/errors.js";

function tooMany(c: Ctx, retryAfter: number, message: string): never {
  c.header("retry-after", String(retryAfter));
  throw new HttpError(429, "rate_limited", `${message}, retry in ${retryAfter}s`);
}

/** Counts this request against the per-IP budget shared by every login-like endpoint; 429 once it is spent. */
export function limitIp(c: Ctx) {
  const d = c.get("deps");
  const wait = d.authLimits.ip.hit(`ip:${clientIp(c)}`, d.now());
  if (wait) tooMany(c, wait, "Too many attempts");
}

/** 429 while the account (e.g. "login:<email>", "2fa:<user id>") has used up its failed attempts. */
export function checkAccount(c: Ctx, key: string) {
  const d = c.get("deps");
  const wait = d.authLimits.account.retryAfter(key, d.now());
  if (wait) {
    d.logger.info("account locked out", { key: key.split(":")[0], ip: clientIp(c) });
    tooMany(c, wait, "Too many failed attempts for this account");
  }
}

export function accountFailed(c: Ctx, key: string) {
  const d = c.get("deps");
  d.authLimits.account.record(key, d.now());
}

export function accountSucceeded(c: Ctx, key: string) {
  c.get("deps").authLimits.account.reset(key);
}
