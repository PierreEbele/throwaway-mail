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
      const takeover = await takeOverCatchAll(deps, domain, zone.id);
      if (takeover.blocked) {
        Object.assign(update, { status: "error", statusDetail: takeover.blocked, dnsMissingJson: null });
        deps.db.update(domains).set(update).where(eq(domains.id, domain.id)).run();
        return deps.db.select().from(domains).where(eq(domains.id, domain.id)).get()!;
      }
      Object.assign(update, takeover.update);
      const missing = await deps.cf.missingDnsRecords(zone.id, domain.name);
      update.dnsMissingJson = JSON.stringify(missing);
      if (missing.length) {
        update.status = "pending";
        update.statusDetail = `Email Routing is enabled but ${missing.length} DNS record(s) are missing. Add them in Cloudflare DNS (or enable Email Routing DNS from the dashboard), then press Re-check.`;
      } else {
        update.status = "active";
        update.statusDetail = `Email Routing enabled; catch-all → Worker "${deps.config.WORKER_NAME}".`;
        if (zone.name !== domain.name) update.statusDetail += ` Note: ${domain.name} is a sub-domain of the ${zone.name} zone; Cloudflare's catch-all only exists at the zone level.`;
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

/**
 * Point the zone catch-all at our Worker without breaking what was there:
 * - an existing "forward to X" catch-all is remembered; the app keeps forwarding unknown addresses to X
 *   (and queues them for review), and restores the rule if the domain is removed;
 * - a catch-all that already sends to ANOTHER Worker is never overwritten.
 */
async function takeOverCatchAll(deps: Deps, domain: Domain, zoneId: string): Promise<{ blocked?: string; update: Partial<Domain> }> {
  const current = await deps.cf.getCatchAll(zoneId);
  const worker = deps.config.WORKER_NAME;
  const ours = !!current?.enabled && current.actions.some((a) => a.type === "worker" && a.value?.includes(worker));
  const update: Partial<Domain> = {};
  if (!ours) {
    const otherWorker = current?.enabled ? current.actions.find((a) => a.type === "worker") : undefined;
    if (otherWorker) {
      return {
        blocked: `The zone's catch-all already sends mail to another Worker ("${otherWorker.value?.join(", ")}"). It was left untouched. Change it in Cloudflare (Email → Email Routing → Routing rules) if you want this app to take over, then press Re-check.`,
        update,
      };
    }
    if (current?.enabled && current.actions.length && !domain.previousCatchAllJson) {
      update.previousCatchAllJson = JSON.stringify(current);
      update.catchallForwardTo = current.actions.find((a) => a.type === "forward")?.value?.[0] ?? null;
      deps.logger.info("preserving existing catch-all", { domain: domain.name, forward: !!update.catchallForwardTo });
    }
    await deps.cf.setCatchAllToWorker(zoneId, worker);
  }
  return { update };
}

/** Give the zone its old catch-all back (called when the domain is removed from the app). */
export async function restoreCatchAll(deps: Deps, domain: Domain): Promise<boolean> {
  if (!domain.cfZoneId || !domain.previousCatchAllJson) return false;
  await deps.cf.setCatchAll(domain.cfZoneId, JSON.parse(domain.previousCatchAllJson));
  return true;
}
