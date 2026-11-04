import { eq } from "drizzle-orm";
import type { Deps } from "../context.js";
import { systemState } from "../db/schema.js";

/** Instance-wide state kept in the system_state table (JSON values). */
export function getState<T>(deps: Pick<Deps, "db">, key: string): T | null {
  const row = deps.db.select().from(systemState).where(eq(systemState.key, key)).get();
  return row ? (JSON.parse(row.valueJson) as T) : null;
}

export function setState(deps: Pick<Deps, "db" | "now">, key: string, value: unknown) {
  const valueJson = JSON.stringify(value);
  const updatedAt = deps.now();
  deps.db
    .insert(systemState)
    .values({ key, valueJson, updatedAt })
    .onConflictDoUpdate({ target: systemState.key, set: { valueJson, updatedAt } })
    .run();
}
