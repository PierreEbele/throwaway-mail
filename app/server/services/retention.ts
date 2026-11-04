import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, categories, messageRaw, messages, sessions } from "../db/schema.js";

/** Delete messages older than RETENTION_DAYS (or their category's own limit) and expired sessions. Returns number of messages deleted. */
export function runRetention(deps: Deps): number {
  const now = deps.now();
  let deleted = 0;
  if (deps.config.RETENTION_DAYS > 0) {
    const cutoff = now - deps.config.RETENTION_DAYS * 86400_000;
    deleted = deps.db.delete(messages).where(lt(messages.receivedAt, cutoff)).run().changes;
  }
  for (const cat of deps.db.select().from(categories).where(isNotNull(categories.retentionDays)).all()) {
    const ids = deps.db
      .select({ id: addresses.id })
      .from(addresses)
      .where(eq(addresses.categoryId, cat.id))
      .all()
      .map((x) => x.id);
    if (!ids.length) continue;
    const cutoff = now - cat.retentionDays! * 86400_000;
    deleted += deps.db
      .delete(messages)
      .where(and(inArray(messages.addressId, ids), lt(messages.receivedAt, cutoff)))
      .run().changes;
  }
  deps.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  // Raw copies kept for retries of failed forwards (quarantined mail has no keep_until and stays).
  deps.db.delete(messageRaw).where(lt(messageRaw.keepUntil, now)).run();
  if (deleted) deps.logger.info("retention: deleted old messages", { count: deleted, days: deps.config.RETENTION_DAYS });
  return deleted;
}
