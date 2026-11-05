import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { backupStatus, runBackup, scheduledBackup, s3Store } from "../../app/server/services/backup/index.js";
import { BACKUP_MAGIC, decryptBackup, encryptBackup } from "../../app/server/services/backup/crypto.js";

const PASSPHRASE = "correct horse battery staple";
const ROOT = path.join(__dirname, "..", "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tm-backup-"));
  dirs.push(d);
  return d;
};

/** In-memory S3 bucket answering the path-style requests of S3Store. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  let failPut = false;
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    const [, bucket, ...rest] = u.pathname.split("/");
    expect(bucket).toBe("backups");
    const key = rest.map(decodeURIComponent).join("/");
    calls.push(`${method} ${key}${u.search}`);
    expect(new Headers(init.headers).get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    if (method === "PUT") {
      if (failPut) return new Response("<Error>SlowDown</Error>", { status: 503 });
      objects.set(key, Buffer.from(init.body as Uint8Array));
      return new Response("");
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      return new Response(
        `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
      );
    }
    const o = objects.get(key);
    return o ? new Response(new Uint8Array(o)) : new Response("NoSuchKey", { status: 404 });
  }) as typeof fetch;
  return {
    objects,
    calls,
    fetch: fetchImpl,
    failPuts: (v: boolean) => {
      failPut = v;
    },
  };
}

async function setup(env: Record<string, string> = {}) {
  const dir = tmp();
  const clock = { now: Date.UTC(2026, 0, 2, 3, 4, 5) };
  const t = makeTestApp({ BACKUP_DIR: dir, ...env }, { now: () => clock.now });
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  const a = (await user.post("/v1/addresses", { site_name: "Shop" })).json.address;
  const r = await ingest(t, a.email, simpleEml({ subject: "Kept in the backup", text: "hello" }), {
    timestamp: Math.floor(clock.now / 1000),
  });
  expect(r.json.action).toBe("store_only");
  return { t, dir, clock, admin, a };
}

const S3_ENV = {
  BACKUP_S3_ENDPOINT: "https://s3.example.com",
  BACKUP_S3_BUCKET: "backups",
  BACKUP_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  BACKUP_S3_SECRET_ACCESS_KEY: "secret",
  BACKUP_S3_KEEP: "2",
  BACKUP_PASSPHRASE: PASSPHRASE,
};

/** Opens a restored database file and returns the subjects of its messages. */
function subjectsIn(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    return (db.prepare("select subject from messages").all() as Array<{ subject: string }>).map((r) => r.subject);
  } finally {
    db.close();
  }
}

describe("backup and restore", () => {
  it("writes an integrity-checked gzipped copy that restores to a working database", async () => {
    const { t, dir } = await setup();
    expect(backupStatus(t.deps)).toMatchObject({ last_run_at: null, offsite: false });
    const s = await runBackup(t.deps);
    expect(s).toMatchObject({ last_ok: true, last_error: null, last_file: "throwaway-20260102-030405.db.gz", last_remote_key: null });
    const gz = fs.readFileSync(path.join(dir, s.last_file!));
    expect(s.last_bytes).toBe(gz.length);
    // No temporary file left behind.
    expect(fs.readdirSync(dir)).toEqual([s.last_file]);
    const out = path.join(tmp(), "restored.db");
    fs.writeFileSync(out, gunzipSync(gz));
    expect(subjectsIn(out)).toEqual(["Kept in the backup"]);
    expect(backupStatus(t.deps)).toMatchObject({ last_ok: true, last_success_at: t.deps.now() });
  });

  it("prunes local copies older than BACKUP_KEEP_DAYS", async () => {
    const { t, dir } = await setup({ BACKUP_KEEP_DAYS: "3" });
    const stale = path.join(dir, "throwaway-20200101-000000.db.gz");
    const other = path.join(dir, "notes.txt");
    fs.writeFileSync(stale, "old");
    fs.writeFileSync(other, "not a backup");
    const old = new Date(t.deps.now() - 10 * 86400_000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(other, old, old);
    await runBackup(t.deps);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("uploads encrypted copies off-site, keeps BACKUP_S3_KEEP of them, and they decrypt back", async () => {
    const s3 = fakeS3();
    const { t, clock } = await setup(S3_ENV);
    t.deps.fetch = s3.fetch;
    s3.objects.set("throwaway-mail/README.txt", Buffer.from("hands off"));
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await runBackup(t.deps);
      expect(s.last_ok).toBe(true);
      keys.push(s.last_remote_key!);
      clock.now += 1000;
    }
    expect(keys[0]).toBe("throwaway-mail/throwaway-20260102-030405.db.gz.enc");
    // The oldest was removed; foreign objects under the prefix are left alone.
    expect([...s3.objects.keys()].sort()).toEqual([...keys.slice(1), "throwaway-mail/README.txt"].sort());
    const enc = s3.objects.get(keys[2]!)!;
    expect(enc.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)).toBe(true);
    expect(() => decryptBackup(enc, "the wrong passphrase")).toThrow();

    const listed = await s3Store(t.deps).list("throwaway-mail/");
    expect(listed).toHaveLength(3);
    const out = path.join(tmp(), "from-s3.db");
    fs.writeFileSync(out, gunzipSync(decryptBackup(await s3Store(t.deps).get(keys[2]!), PASSPHRASE)));
    expect(subjectsIn(out)).toEqual(["Kept in the backup"]);
  });

  it("records failures and alerts admins on scheduled runs", async () => {
    const s3 = fakeS3();
    const { t, admin } = await setup(S3_ENV);
    const pushes: string[] = [];
    t.deps.fetch = (async (input: string, init: RequestInit) => {
      if (String(input).startsWith("https://ntfy.sh/")) {
        pushes.push((init.headers as Record<string, string>).title!);
        return new Response("ok");
      }
      return s3.fetch(input, init);
    }) as typeof fetch;
    expect(
      (await admin.post("/v1/notify-targets", { kind: "ntfy", name: "Ops", url: "https://ntfy.sh/ops", events: ["system.alert"] })).status,
    ).toBe(201);
    s3.failPuts(true);
    const s = await scheduledBackup(t.deps);
    expect(s.last_ok).toBe(false);
    expect(s.last_error).toContain("HTTP 503");
    expect(pushes).toEqual(["Backup failed"]);
    expect(backupStatus(t.deps)).toMatchObject({ last_ok: false, last_success_at: null, offsite: true });

    s3.failPuts(false);
    expect((await scheduledBackup(t.deps)).last_ok).toBe(true);
    expect(pushes).toHaveLength(1);
  });

  it("backup-cli decrypt restores a downloaded file and refuses to overwrite", () => {
    const dir = tmp();
    const src = new Database(path.join(dir, "src.db"));
    src.exec("create table t (v text); insert into t values ('restored')");
    src.close();
    const enc = path.join(dir, "b.db.gz.enc");
    fs.writeFileSync(enc, encryptBackup(gzipSync(fs.readFileSync(path.join(dir, "src.db"))), PASSPHRASE));
    const out = path.join(dir, "out.db");
    const cli = (args: string[], env: Record<string, string> = {}) =>
      execFileSync(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts/backup-cli.ts"), ...args], {
        cwd: ROOT,
        env: { ...process.env, BACKUP_PASSPHRASE: PASSPHRASE, ...env },
        stdio: "pipe",
      }).toString();
    expect(cli(["decrypt", enc, out])).toContain(`wrote ${out}`);
    const db = new Database(out, { readonly: true });
    expect(db.prepare("select v from t").get()).toEqual({ v: "restored" });
    db.close();
    expect(() => cli(["decrypt", enc, out])).toThrow(/refusing to overwrite/);
    expect(() => cli(["decrypt", enc, path.join(dir, "other.db")], { BACKUP_PASSPHRASE: "" })).toThrow(/BACKUP_PASSPHRASE/);
    expect(() => cli(["decrypt"])).toThrow(/usage/);
  });
});
