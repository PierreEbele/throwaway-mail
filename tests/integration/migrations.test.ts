import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../app/server/db/index.js";

const MIGRATIONS = "app/server/db/migrations";

/** A copy of the migrations folder containing only migrations up to `lastIdx`. */
function migrationsUpTo(lastIdx: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mig-"));
  fs.cpSync(MIGRATIONS, dir, { recursive: true });
  const journalFile = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  for (const e of journal.entries.filter((x) => x.idx > lastIdx)) fs.rmSync(path.join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.filter((x) => x.idx <= lastIdx);
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  return { dir, file: path.join(dir, "test.db") };
}

describe("migrations", () => {
  it("rebuilding the users table (0017) keeps every row that references a user", () => {
    const { dir, file } = migrationsUpTo(16);
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old), { migrationsFolder: dir });
    const now = Date.now();
    old.prepare("insert into users (id, oidc_sub, email, role, created_at) values ('u1', 'sub1', 'a@x.test', 'admin', ?)").run(now);
    old
      .prepare(
        "insert into domains (id, name, status, unknown_policy, created_by, created_at) values ('d1', 'x.test', 'active', 'reject', 'u1', ?)",
      )
      .run(now);
    old
      .prepare(
        "insert into addresses (id, user_id, domain_id, local_part, site_name, created_at, updated_at) values ('a1', 'u1', 'd1', 'foo', 'Site', ?, ?)",
      )
      .run(now, now);
    old
      .prepare(
        "insert into messages (id, address_id, user_id, envelope_to, received_at, raw_size) values ('m1', 'a1', 'u1', 'foo@x.test', ?, 1)",
      )
      .run(now);
    old
      .prepare("insert into sessions (id, user_id, csrf_token, created_at, expires_at) values ('s1', 'u1', 'c', ?, ?)")
      .run(now, now + 60_000);
    old.close();

    const db = openDatabase(file, MIGRATIONS).$client;
    const count = (t: string) => (db.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n;
    expect(["users", "domains", "addresses", "messages", "sessions"].map(count)).toEqual([1, 1, 1, 1, 1]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});
