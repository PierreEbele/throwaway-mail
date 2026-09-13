import { lt } from "drizzle-orm";
import type { Deps } from "../context.js";
import { messages, sessions } from "../db/schema.js";

/** Delete messages older than RETENTION_DAYS and expired sessions. Returns number of messages deleted. */
export function runRetention(deps: Deps): number {
  const now = deps.now();
  let deleted = 0;
  if (deps.config.RETENTION_DAYS > 0) {
    const cutoff = now - deps.config.RETENTION_DAYS * 86400_000;
    deleted = deps.db.delete(messages).where(lt(messages.receivedAt, cutoff)).run().changes;
  }
  deps.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  if (deleted) deps.logger.info("retention: deleted old messages", { count: deleted, days: deps.config.RETENTION_DAYS });
  return deleted;
}
