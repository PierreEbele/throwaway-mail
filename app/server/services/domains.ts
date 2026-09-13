import { eq } from "drizzle-orm";
import type { Deps } from "../context.js";
import { domains, type Domain } from "../db/schema.js";
import { CloudflareError } from "../cloudflare/index.js";

/**
 * (Re)configure Cloudflare for a domain: find zone, enable Email Routing, point the catch-all rule
 * at the Worker, then check DNS. Never throws; the outcome is stored on the domain row.
 */
export async function setupDomain(deps: Deps, domain: Domain): Promise<Domain> {
  const log = deps.logger.child({ component: "domains", domain: domain.name });
  const update: Partial<Domain> = { lastCheckedAt: deps.now() };
  try {
    const zone = await deps.cf.findZone(domain.name);
    if (!zone) {
      Object.assign(update, {
        status: "error",
        cfZoneId: null,
        statusDetail: `No Cloudflare zone found for ${domain.name}. Add the domain to the same Cloudflare account (its nameservers must point to Cloudflare), then press Re-check.`,
        dnsMissingJson: null,
      });
    } else {
      update.cfZoneId = zone.id;
      await deps.cf.enableEmailRouting(zone.id, domain.name);
      await deps.cf.setCatchAllToWorker(zone.id, deps.config.WORKER_NAME);
      const missing = await deps.cf.missingDnsRecords(zone.id, domain.name);
      update.dnsMissingJson = JSON.stringify(missing);
      if (missing.length) {
        update.status = "pending";
        update.statusDetail = `Email Routing is enabled but ${missing.length} DNS record(s) are missing. Add them in Cloudflare DNS (or enable Email Routing DNS from the dashboard), then press Re-check.`;
      } else {
        update.status = "active";
        update.statusDetail = `Email Routing enabled; catch-all → Worker "${deps.config.WORKER_NAME}".`;
      }
    }
  } catch (e) {
    const msg = e instanceof CloudflareError ? e.message : `Unexpected error: ${(e as Error).message}`;
    log.warn("domain setup failed", { err: msg });
    update.status = "error";
    update.statusDetail = msg;
  }
  deps.db.update(domains).set(update).where(eq(domains.id, domain.id)).run();
  log.info("domain checked", { status: update.status });
  return deps.db.select().from(domains).where(eq(domains.id, domain.id)).get()!;
}
