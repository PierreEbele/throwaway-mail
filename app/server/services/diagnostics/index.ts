import type { Deps } from "../../context.js";
import { domains } from "../../db/schema.js";
import { appUrlChecks, secretChecks, signInChecks } from "./app.js";
import { backupCheck } from "./backup.js";
import { cloudflareChecks, cloudflareDomainChecks } from "./cloudflare.js";
import { imapDomainChecks, lastMailCheck } from "./domains.js";
import { msg, type Check, type CheckStatus, type Diagnostics } from "./types.js";

export type { Check, CheckStatus, Diagnostics } from "./types.js";

/**
 * Setup check: what is configured, what is missing and how to fix it. Used by GET /v1/admin/diagnostics, the
 * admin "Setup check" page and `pnpm doctor`. Every outside call goes through `deps` (fetch, resolveMx, cf, mail),
 * so tests run without network. Never throws: a failing probe becomes an "error" check.
 */

export async function runDiagnostics(deps: Deps): Promise<Diagnostics> {
  const all = deps.db.select().from(domains).orderBy(domains.name).all();
  const cfDomains = all.filter((d) => d.transport === "cloudflare");
  const imapDomains = all.filter((d) => d.transport === "imap");
  const guard = async (id: string, f: () => Promise<Check[]>): Promise<Check[]> => {
    try {
      return await f();
    } catch (e) {
      return [{ id, group: "app", title: id, status: "error", detail: `Check crashed: ${msg(e)}` }];
    }
  };

  const groups = await Promise.all([
    guard("app_url", () => appUrlChecks(deps)),
    guard("secrets", async () => secretChecks(deps)),
    guard("sign_in", () => signInChecks(deps)),
    guard("cloudflare", () => cloudflareChecks(deps, cfDomains)),
    ...cfDomains.map((d) => guard(`domain:${d.name}`, async () => [...(await cloudflareDomainChecks(deps, d)), lastMailCheck(deps, d)])),
    ...imapDomains.map((d) => guard(`domain:${d.name}`, async () => [...(await imapDomainChecks(deps, d)), lastMailCheck(deps, d)])),
    guard("backups", async () => [backupCheck(deps)]),
  ]);
  const checks = groups.flat();
  if (!all.length)
    checks.push({
      id: "domains",
      group: "domains",
      title: "Domains",
      status: "warn",
      detail: "No domain yet",
      hint: "Add one in Admin → Domains (Cloudflare Email Routing, or an IMAP/SMTP catch-all mailbox).",
    });
  const order: Check["group"][] = ["app", "sign-in", "cloudflare", "domains", "operations"];
  checks.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.status]++;
  return { generated_at: deps.now(), summary, checks };
}
