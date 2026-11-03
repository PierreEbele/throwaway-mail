import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDatabase(file: string, migrationsFolder: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema }) as DB;
  migrateSafely(sqlite, db, migrationsFolder);
  sqlite.pragma("foreign_keys = ON");
  return db;
}

/**
 * Runs migrations with foreign keys off. Drizzle rebuilds a table (create copy, drop, rename) to change a column,
 * and its own "PRAGMA foreign_keys=OFF" has no effect inside the migration transaction: with keys on, dropping the
 * old table would cascade-delete every row that references it. Integrity is checked before keys are turned back on.
 */
function migrateSafely(sqlite: Database.Database, db: DB, migrationsFolder: string) {
  sqlite.pragma("foreign_keys = OFF");
  migrate(db, { migrationsFolder });
  const broken = sqlite.pragma("foreign_key_check") as unknown[];
  if (broken.length) throw new Error(`Database migration left ${broken.length} broken foreign key reference(s)`);
}

export { schema };
