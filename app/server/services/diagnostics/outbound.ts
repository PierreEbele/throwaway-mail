import type { Deps } from "../../context.js";
import type { Check } from "./types.js";

/** Which outbound transport is selected (OUTBOUND_TRANSPORT) and whether it can work. */
export function outboundCheck(deps: Deps): Check {
  const base = { id: "outbound", group: "app" as const, title: "Outbound mail transport" };
  if (deps.config.OUTBOUND_TRANSPORT === "cloudflare") {
    if (deps.cf.mode === "unconfigured")
      return {
        ...base,
        status: "error",
        detail: "OUTBOUND_TRANSPORT=cloudflare but Cloudflare is not configured",
        hint: "Set CF_API_TOKEN and CF_ACCOUNT_ID.",
      };
    return {
      ...base,
      status: deps.cf.mode === "mock" ? "warn" : "ok",
      detail:
        deps.cf.mode === "mock" ? "Cloudflare Email Sending (mock: nothing is sent)" : "Cloudflare Email Sending (REST API, send_raw)",
      hint: "The token needs Account → Email Sending → Edit, and every alias domain must be onboarded to Email Sending (Cloudflare dashboard → Email Service). See docs/cloudflare-tokens.md.",
    };
  }
  return deps.config.SMTP_RELAY_URL
    ? { ...base, status: "ok", detail: "SMTP relay (SMTP_RELAY_URL)" }
    : {
        ...base,
        status: "ok",
        detail: "SMTP, but SMTP_RELAY_URL is not set: only IMAP domains with their own SMTP server can send",
        hint: "Set SMTP_RELAY_URL or OUTBOUND_TRANSPORT=cloudflare to enable replies and sending on Cloudflare domains.",
      };
}
