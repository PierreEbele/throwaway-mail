import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import type { Deps } from "../../context.js";
import { metrics } from "../metrics.js";
import { notifyAdmins } from "../notify.js";
import { getState, setState } from "../state.js";
import { encryptBackup } from "./crypto.js";
import { S3Store } from "./s3.js";

export interface BackupStatus {
  /** Last run, successful or not. */
  last_run_at: number | null;
  last_ok: boolean | null;
  last_error: string | null;
  last_success_at: number | null;
  last_file: string | null;
  last_bytes: number | null;
  /** Object key of the last off-site upload. */
  last_remote_key: string | null;
  offsite: boolean;
}

const STATE_KEY = "backup.status";
type BackupDeps = Pick<Deps, "config" | "db" | "logger" | "now" | "fetch">;

export function backupStatus(deps: Pick<Deps, "db" | "config">): BackupStatus {
  const s = getState<Partial<BackupStatus>>(deps, STATE_KEY) ?? {};
  return {
    last_run_at: s.last_run_at ?? null,
    last_ok: s.last_ok ?? null,
    last_error: s.last_error ?? null,
    last_success_at: s.last_success_at ?? null,
    last_file: s.last_file ?? null,
    last_bytes: s.last_bytes ?? null,
    last_remote_key: s.last_remote_key ?? null,
    offsite: deps.config.offsiteBackup,
  };
}

export function s3Store(deps: Pick<Deps, "config" | "fetch">): S3Store {
  const c = deps.config;
  return new S3Store(
    {
      endpoint: c.BACKUP_S3_ENDPOINT!,
      bucket: c.BACKUP_S3_BUCKET!,
      region: c.BACKUP_S3_REGION,
      accessKeyId: c.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: c.BACKUP_S3_SECRET_ACCESS_KEY!,
    },
    deps.fetch,
  );
}

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.\d+Z$/, "");

/** Online copy of the database, integrity-checked and gzipped into BACKUP_DIR; local copies older than BACKUP_KEEP_DAYS are removed. */
async function localBackup(deps: BackupDeps): Promise<{ file: string; gz: Buffer }> {
  const dir = deps.config.backupDir;
  fs.mkdirSync(dir, { recursive: true });
  const base = `throwaway-${stamp(deps.now())}.db`;
  const tmp = path.join(dir, `.${base}.tmp`);
  try {
    await deps.db.$client.backup(tmp);
    const check = new Database(tmp, { readonly: true });
    let result: unknown;
    try {
      result = check.pragma("integrity_check", { simple: true });
    } finally {
      check.close();
    }
    if (result !== "ok") throw new Error(`integrity check failed: ${String(result)}`);
    const gz = gzipSync(fs.readFileSync(tmp), { level: 9 });
    const file = path.join(dir, `${base}.gz`);
    fs.writeFileSync(file, gz);
    return { file, gz };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function pruneLocal(deps: BackupDeps) {
  const dir = deps.config.backupDir;
  const limit = deps.now() - deps.config.BACKUP_KEEP_DAYS * 86400_000;
  for (const f of fs.readdirSync(dir)) {
    if (!/^throwaway-.*\.db\.gz$/.test(f)) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { force: true });
  }
}

/** Uploads the encrypted copy, then keeps only the BACKUP_S3_KEEP newest objects under the prefix. */
async function offsite(deps: BackupDeps, name: string, gz: Buffer): Promise<{ key: string; deleted: number }> {
  const c = deps.config;
  const store = s3Store(deps);
  const key = `${c.BACKUP_S3_PREFIX}${name}.enc`;
  await store.put(key, encryptBackup(gz, c.BACKUP_PASSPHRASE!));
  const keys = (await store.list(c.BACKUP_S3_PREFIX))
    .filter((k) => /throwaway-\d{8}-\d{6}\.db\.gz\.enc$/.test(k))
    .sort()
    .reverse();
  const old = keys.slice(c.BACKUP_S3_KEEP);
  for (const k of old) await store.delete(k);
  return { key, deleted: old.length };
}

/** One backup run: local copy, then (when configured) encrypted off-site upload with retention. Records the outcome. */
export async function runBackup(deps: BackupDeps): Promise<BackupStatus> {
  const prev = backupStatus(deps);
  const at = deps.now();
  try {
    const { file, gz } = await localBackup(deps);
    pruneLocal(deps);
    let remote: { key: string; deleted: number } | null = null;
    if (deps.config.offsiteBackup) remote = await offsite(deps, path.basename(file), gz);
    const status: BackupStatus = {
      ...prev,
      last_run_at: at,
      last_ok: true,
      last_error: null,
      last_success_at: at,
      last_file: path.basename(file),
      last_bytes: gz.length,
      last_remote_key: remote?.key ?? null,
    };
    setState(deps, STATE_KEY, status);
    metrics.backups.inc({ result: "ok" });
    metrics.job("backup", true, remote ? `uploaded ${remote.key}, ${remote.deleted} old removed` : path.basename(file));
    deps.logger.info("backup ok", { file, bytes: gz.length, remote: remote?.key });
    return status;
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    const status: BackupStatus = { ...prev, last_run_at: at, last_ok: false, last_error: error };
    setState(deps, STATE_KEY, status);
    metrics.backups.inc({ result: "error" });
    metrics.job("backup", false, error);
    deps.logger.error("backup failed", { err: error });
    return status;
  }
}

/** Runs a backup and alerts admins (system.alert) when it fails. */
export async function scheduledBackup(deps: Deps): Promise<BackupStatus> {
  const s = await runBackup(deps);
  if (!s.last_ok) {
    await notifyAdmins(deps, {
      title: "Backup failed",
      body: s.last_error ?? "unknown error",
      url: `${deps.config.APP_URL.replace(/\/$/, "")}/admin`,
    });
  }
  return s;
}
