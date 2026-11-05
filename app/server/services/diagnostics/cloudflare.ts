import type { Deps } from "../../context.js";
import type { Domain } from "../../db/schema.js";
import { CLOUDFLARE_MX, msg, type Check } from "./types.js";
export async function cloudflareChecks(deps: Deps, cfDomains: Domain[]): Promise<Check[]> {
  const { cf, config } = deps;
  if (cf.mode === "unconfigured") {
    return [
      {
        id: "cloudflare.token",
        group: "cloudflare",
        title: "Cloudflare API token",
        status: cfDomains.length ? "error" : "ok",
        detail: cfDomains.length
          ? `Not configured, but ${cfDomains.length} Cloudflare domain(s) exist`
          : "Not configured: only IMAP/SMTP mailbox domains can be used",
        hint: cfDomains.length
          ? "Set CF_API_TOKEN and CF_ACCOUNT_ID in .env and restart (see Installation → Cloudflare token)."
          : undefined,
      },
    ];
  }
  if (cf.mode === "mock")
    return [
      {
        id: "cloudflare.token",
        group: "cloudflare",
        title: "Cloudflare API token",
        status: "warn",
        detail: "CF_MOCK=1: no real Cloudflare calls are made",
        hint: "Remove CF_MOCK for a real installation.",
      },
    ];

  const out: Check[] = [];
  try {
    const t = await cf.verifyToken();
    out.push(
      t.status === "active"
        ? {
            id: "cloudflare.token",
            group: "cloudflare",
            title: "Cloudflare API token",
            status: "ok",
            detail: `Active${t.expiresOn ? `, expires ${t.expiresOn}` : ""}`,
          }
        : {
            id: "cloudflare.token",
            group: "cloudflare",
            title: "Cloudflare API token",
            status: "error",
            detail: `Token is ${t.status}`,
            hint: "Create a new token (Installation → Cloudflare token) and update CF_API_TOKEN.",
          },
    );
  } catch (e) {
    return [
      {
        id: "cloudflare.token",
        group: "cloudflare",
        title: "Cloudflare API token",
        status: "error",
        detail: msg(e),
        hint: "CF_API_TOKEN is invalid or Cloudflare is unreachable. Check the value (no quotes or spaces) and the server's outbound access. Step by step: docs/cloudflare-tokens.md.",
      },
    ];
  }
  try {
    await cf.findDestinationByEmail("setup-check@invalid.example");
    out.push({
      id: "cloudflare.addresses",
      group: "cloudflare",
      title: "Permission: Email Routing Addresses",
      status: "ok",
      detail: "Destination addresses can be read",
    });
  } catch (e) {
    out.push({
      id: "cloudflare.addresses",
      group: "cloudflare",
      title: "Permission: Email Routing Addresses",
      status: "error",
      detail: msg(e),
      hint: "Give the token Account → Email Routing Addresses → Edit, and check CF_ACCOUNT_ID (Cloudflare dashboard → account home → Account ID).",
    });
  }
  try {
    const exists = await cf.workerExists(config.WORKER_NAME);
    out.push(
      exists === null
        ? {
            id: "cloudflare.worker",
            group: "cloudflare",
            title: "Email Worker deployed",
            status: "ok",
            detail: "Not checked: the token may not read Workers scripts (optional permission)",
          }
        : exists
          ? {
              id: "cloudflare.worker",
              group: "cloudflare",
              title: "Email Worker deployed",
              status: "ok",
              detail: `Worker "${config.WORKER_NAME}" exists`,
            }
          : {
              id: "cloudflare.worker",
              group: "cloudflare",
              title: "Email Worker deployed",
              status: "error",
              detail: `No Worker named "${config.WORKER_NAME}" in this account`,
              hint: "Deploy the Worker (Installation → Email Worker) or set WORKER_NAME to the name in worker/wrangler.toml.",
            },
    );
  } catch (e) {
    out.push({ id: "cloudflare.worker", group: "cloudflare", title: "Email Worker deployed", status: "warn", detail: msg(e) });
  }
  return out;
}

export async function cloudflareDomainChecks(deps: Deps, d: Domain): Promise<Check[]> {
  const out: Check[] = [];
  const id = (k: string) => `domain.${k}:${d.name}`;
  // MX records, straight from DNS (what senders see).
  try {
    const mx = await deps.resolveMx(d.name);
    const cfMx = mx.filter((m) => CLOUDFLARE_MX.test(m.exchange));
    if (!mx.length)
      out.push({
        id: id("mx"),
        group: "domains",
        title: `${d.name}: MX records`,
        status: "error",
        detail: "No MX record: nobody can send mail to this domain",
        hint: "Cloudflare dashboard → the zone → Email → Email Routing → Settings → add the records it shows (route1/2/3.mx.cloudflare.net), or press Check on the domain.",
      });
    else if (cfMx.length < mx.length)
      out.push({
        id: id("mx"),
        group: "domains",
        title: `${d.name}: MX records`,
        status: cfMx.length ? "warn" : "error",
        detail: `MX: ${mx.map((m) => `${m.exchange} (${m.priority})`).join(", ")}`,
        hint: "Some MX records do not point to Cloudflare Email Routing (*.mx.cloudflare.net); mail sent to them never reaches the app. Delete the other MX records.",
      });
    else
      out.push({
        id: id("mx"),
        group: "domains",
        title: `${d.name}: MX records`,
        status: "ok",
        detail: mx.map((m) => m.exchange).join(", "),
      });
  } catch (e) {
    out.push({ id: id("mx"), group: "domains", title: `${d.name}: MX records`, status: "warn", detail: `DNS lookup failed: ${msg(e)}` });
  }

  if (deps.cf.mode === "unconfigured") return out;
  if (!d.cfZoneId) {
    out.push({
      id: id("routing"),
      group: "domains",
      title: `${d.name}: Email Routing`,
      status: "error",
      detail: "The domain has no Cloudflare zone recorded",
      hint: "Press Check on the domain in Admin → Domains; if the zone is not found, add the domain to this Cloudflare account first.",
    });
    return out;
  }
  try {
    const enabled = await deps.cf.emailRoutingEnabled(d.cfZoneId);
    out.push(
      enabled
        ? { id: id("routing"), group: "domains", title: `${d.name}: Email Routing`, status: "ok", detail: "Enabled" }
        : {
            id: id("routing"),
            group: "domains",
            title: `${d.name}: Email Routing`,
            status: "error",
            detail: "Email Routing is disabled on the zone",
            hint: "Press Check on the domain (the app enables it), or Cloudflare dashboard → Email → Email Routing → Enable.",
          },
    );
  } catch (e) {
    out.push({
      id: id("routing"),
      group: "domains",
      title: `${d.name}: Email Routing`,
      status: "error",
      detail: msg(e),
      hint: "The token needs Zone → Zone → Read and Zone → Email Routing Rules → Edit on this zone.",
    });
  }
  try {
    const rule = await deps.cf.getCatchAll(d.cfZoneId);
    const worker = rule?.enabled && rule.actions.some((a) => a.type === "worker" && a.value?.includes(deps.config.WORKER_NAME));
    out.push(
      worker
        ? {
            id: id("worker_route"),
            group: "domains",
            title: `${d.name}: catch-all → Worker`,
            status: "ok",
            detail: `Catch-all sends to "${deps.config.WORKER_NAME}"`,
          }
        : {
            id: id("worker_route"),
            group: "domains",
            title: `${d.name}: catch-all → Worker`,
            status: "error",
            detail: rule
              ? `Catch-all is ${rule.enabled ? "enabled" : "disabled"} with ${rule.actions.map((a) => `${a.type}${a.value?.length ? ` ${a.value.join(", ")}` : ""}`).join("; ") || "no action"}`
              : "No catch-all rule",
            hint: `Press Check on the domain (the app sets it), or Cloudflare dashboard → Email Routing → Routing rules → Catch-all → Send to a Worker → ${deps.config.WORKER_NAME}.`,
          },
    );
  } catch (e) {
    out.push({ id: id("worker_route"), group: "domains", title: `${d.name}: catch-all → Worker`, status: "error", detail: msg(e) });
  }
  return out;
}
