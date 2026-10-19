/** Heuristics flagging mail that may impersonate the site an address was created for. */
import { baseDomain, hostOf, senderDomain } from "./senders.js";

const HOMOGLYPHS: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", rn: "m", vv: "w", cl: "d" };

/** Normalises common look-alike characters so "paypa1" and "paypal" compare equal. */
export function skeleton(s: string): string {
  let out = s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const [k, v] of Object.entries(HOMOGLYPHS)) out = out.split(k).join(v);
  return out.replace(/[^a-z]/g, "");
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Sender domain imitating the site (paypa1.com for paypal.com, g00gle.com...), but not the site itself. */
export function isLookalike(siteUrl: string | null, sender: string | null): boolean {
  const site = hostOf(siteUrl);
  const from = senderDomain(sender);
  if (!site || !from) return false;
  const a = baseDomain(site).split(".")[0]!;
  const b = baseDomain(from).split(".")[0]!;
  if (a === b || a.length < 4) return false;
  if (skeleton(a) === skeleton(b)) return true;
  if (b.includes(a) && b !== a) return /[-.]?(secure|login|verify|account|support|help|service|update|billing)/.test(b.replace(a, ""));
  return a.length >= 6 && distance(a, b) === 1;
}

export type AuthWarning = "auth_failed" | "lookalike" | null;

/** "auth_failed" when DMARC fails (or SPF and DKIM both fail), "lookalike" for an imitation of the site's domain. */
export function authWarning(siteUrl: string | null, sender: string | null, auth: { spf: string | null; dkim: string | null; dmarc: string | null }): AuthWarning {
  if (isLookalike(siteUrl, sender)) return "lookalike";
  const bad = (v: string | null) => v === "fail" || v === "softfail" || v === "permerror";
  if (bad(auth.dmarc) || (bad(auth.spf) && bad(auth.dkim))) return "auth_failed";
  return null;
}
