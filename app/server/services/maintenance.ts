import { eq, isNotNull } from "drizzle-orm";
import type { Deps } from "../context.js";
import { messages } from "../db/schema.js";
import { authResult } from "./ingest.js";

/** Recompute stored SPF results with the current parser (fixes mails stored before the HELO/MAIL FROM fix). Idempotent. */
export function backfillAuthResults(deps: Deps): number {
  const rows = deps.db.select({ id: messages.id, spf: messages.spf, headersJson: messages.headersJson }).from(messages).where(isNotNull(messages.headersJson)).all();
  let changed = 0;
  for (const r of rows) {
    const spf = authResult(JSON.parse(r.headersJson!), "spf");
    if (spf !== r.spf) {
      deps.db.update(messages).set({ spf }).where(eq(messages.id, r.id)).run();
      changed++;
    }
  }
  if (changed) deps.logger.info("backfilled SPF results", { count: changed });
  return changed;
}
