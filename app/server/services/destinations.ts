import { and, eq, ne } from "drizzle-orm";
import type { Deps } from "../context.js";
import { destinations, type Destination } from "../db/schema.js";
import { CloudflareError } from "../cloudflare/index.js";

function errMsg(e: unknown) {
  return e instanceof CloudflareError ? e.message : (e as Error).message;
}

/** Ask Cloudflare for the current verification state and store it. */
export async function refreshDestination(deps: Deps, d: Destination): Promise<Destination> {
  const update: Partial<Destination> = {};
  try {
    let info = d.cfDestinationId ? await deps.cf.getDestination(d.cfDestinationId) : null;
    if (!info) info = await deps.cf.findDestinationByEmail(d.email);
    if (!info) info = await deps.cf.createDestination(d.email);
    update.cfDestinationId = info.id;
    update.verifiedAt = info.verified ? Date.parse(info.verified) || deps.now() : null;
    update.lastError = null;
  } catch (e) {
    update.lastError = errMsg(e);
  }
  deps.db.update(destinations).set(update).where(eq(destinations.id, d.id)).run();
  return deps.db.select().from(destinations).where(eq(destinations.id, d.id)).get()!;
}

/** Re-send the Cloudflare verification e-mail (Cloudflare has no resend endpoint: delete + recreate). */
export async function resendVerification(deps: Deps, d: Destination): Promise<Destination> {
  try {
    if (d.cfDestinationId && !sharedWithOthers(deps, d)) await deps.cf.deleteDestination(d.cfDestinationId);
    const info = await deps.cf.createDestination(d.email);
    deps.db
      .update(destinations)
      .set({ cfDestinationId: info.id, verifiedAt: info.verified ? Date.parse(info.verified) || deps.now() : null, lastError: null })
      .where(eq(destinations.id, d.id))
      .run();
  } catch (e) {
    deps.db
      .update(destinations)
      .set({ lastError: errMsg(e) })
      .where(eq(destinations.id, d.id))
      .run();
  }
  return deps.db.select().from(destinations).where(eq(destinations.id, d.id)).get()!;
}

/** Cloudflare destinations are account-wide; another user may rely on the same address. */
export function sharedWithOthers(deps: Deps, d: Destination): boolean {
  return !!deps.db
    .select({ id: destinations.id })
    .from(destinations)
    .where(and(eq(destinations.email, d.email), ne(destinations.id, d.id)))
    .get();
}
