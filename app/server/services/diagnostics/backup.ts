import fs from "node:fs";
import path from "node:path";
import type { Deps } from "../../context.js";
import { BACKUP_MAX_AGE_DAYS, DAY, ago, type Check } from "./types.js";
export function backupCheck(deps: Deps): Check {
  const dir = path.join(deps.config.DATA_DIR, "backups");
  let newest = 0;
  let count = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^throwaway-.*\.db(\.gz)?$/.test(f)) continue;
      count++;
      newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs);
    }
  } catch {
    /* no backup directory */
  }
  const hint =
    "Schedule scripts/backup.sh daily from the host's cron: `15 3 * * * cd /opt/throwaway-mail && docker compose exec -T app sh scripts/backup.sh`, and copy /data/backups off the server (Operations → Backups).";
  if (!count) return { id: "backups", group: "operations", title: "Backups", status: "warn", detail: `No backup in ${dir}`, hint };
  const now = deps.now();
  if (now - newest > BACKUP_MAX_AGE_DAYS * DAY)
    return {
      id: "backups",
      group: "operations",
      title: "Backups",
      status: "warn",
      detail: `Newest of ${count} backup(s) is from ${ago(now, newest)}`,
      hint,
    };
  return { id: "backups", group: "operations", title: "Backups", status: "ok", detail: `${count} backup(s), newest ${ago(now, newest)}` };
}
