/**
 * Backup command line (bundled to dist/backup-cli.js; settings from the same environment as the server).
 *
 *   node dist/backup-cli.js run                      make a backup now (local + encrypted off-site upload when configured)
 *   node dist/backup-cli.js list                     list off-site backups
 *   node dist/backup-cli.js fetch <key> <out.db>     download, decrypt and decompress an off-site backup
 *   node dist/backup-cli.js decrypt <in.enc> <out.db>  decrypt and decompress a downloaded .db.gz.enc file
 *
 * fetch / decrypt need BACKUP_PASSPHRASE; fetch / list need the BACKUP_S3_* variables.
 */
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "../app/server/config.js";
import { openDatabase } from "../app/server/db/index.js";
import { createLogger } from "../app/server/logger.js";
import { decryptBackup } from "../app/server/services/backup/crypto.js";
import { runBackup, s3Store } from "../app/server/services/backup/index.js";

function usage(): never {
  console.error("usage: backup-cli run | list | fetch <key> <out.db> | decrypt <in.enc> <out.db>");
  process.exit(2);
}

function restoreTo(out: string, enc: Buffer, passphrase: string | undefined) {
  if (!passphrase) throw new Error("BACKUP_PASSPHRASE is not set");
  const db = gunzipSync(decryptBackup(enc, passphrase));
  if (fs.existsSync(out)) throw new Error(`${out} exists; refusing to overwrite it`);
  fs.writeFileSync(out, db);
  console.log(`wrote ${out} (${db.length} bytes)`);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "decrypt") {
    if (!a || !b) usage();
    restoreTo(b, fs.readFileSync(a), process.env.BACKUP_PASSPHRASE);
    return;
  }
  const config = loadConfig();
  const deps = { config, fetch };
  switch (cmd) {
    case "run": {
      const logger = createLogger(config.LOG_LEVEL, { service: "throwaway-backup" });
      const db = openDatabase(config.databasePath, config.MIGRATIONS_DIR);
      const s = await runBackup({ ...deps, db, logger, now: () => Date.now() });
      db.$client.close();
      if (!s.last_ok) throw new Error(s.last_error ?? "backup failed");
      console.log(`backup ok: ${s.last_file}${s.last_remote_key ? ` → ${s.last_remote_key}` : ""}`);
      return;
    }
    case "list": {
      if (!config.offsiteBackup) throw new Error("off-site backups are not configured (BACKUP_S3_*)");
      for (const k of (await s3Store(deps).list(config.BACKUP_S3_PREFIX)).sort()) console.log(k);
      return;
    }
    case "fetch": {
      if (!a || !b) usage();
      if (!config.offsiteBackup) throw new Error("off-site backups are not configured (BACKUP_S3_*)");
      restoreTo(b, await s3Store(deps).get(a), config.BACKUP_PASSPHRASE);
      return;
    }
    default:
      usage();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
