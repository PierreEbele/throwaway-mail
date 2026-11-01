import type { Deps } from "../context.js";
import { auditLog } from "../db/schema.js";
import { newId } from "../lib/crypto.js";

export function audit(
  deps: Deps,
  userId: string | null,
  action: string,
  target: string | null,
  meta?: Record<string, unknown>,
  ip?: string | null,
) {
  deps.db
    .insert(auditLog)
    .values({
      id: newId("aud"),
      userId,
      action,
      target,
      metaJson: meta ? JSON.stringify(meta) : null,
      ip: ip ?? null,
      createdAt: deps.now(),
    })
    .run();
  deps.logger.info("audit", { action, target, user_id: userId });
}
