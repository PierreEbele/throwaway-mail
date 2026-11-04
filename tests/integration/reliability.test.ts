import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup } from "../../app/server/services/backup/crypto.js";
import { runBackup } from "../../app/server/services/backup/index.js";
import { parseSmtpUrl, probeTick } from "../../app/server/services/probe.js";
import { notifyTargets, users } from "../../app/server/db/schema.js";
import { newId } from "../../app/server/lib/crypto.js";
import { fakeMail, SmtpError } from "../mail-fakes.js";
import { addDomain, ingest, inviteUser, makeTestApp, setupAdmin } from "../helpers.js";

const PASS = "correct horse battery staple";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tm-backup-"));
  dirs.push(d);
  return d;
}

/** In-memory S3 bucket answering the few calls S3Store makes. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) return new Response("unsigned", { status: 403 });
    const [, bucket, ...rest] = url.pathname.split("/");
    expect(bucket).toBe("bk");
    const key = rest.map(decodeURIComponent).join("/");
    calls.push(`${method} ${key}`);
    if (method === "PUT") {
      objects.set(key, Buffer.from(init!.body as Uint8Array));
      return new Response("");
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!key) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
    }
    const o = objects.get(key);
    return o ? new Response(new Uint8Array(o)) : new Response("NoSuchKey", { status: 404 });
  }) as typeof fetch;
  return { objects, calls, fetchImpl };
}

const s3Env = (dir: string) => ({
  BACKUP_DIR: dir,
  BACKUP_S3_ENDPOINT: "https://s3.example.test",
  BACKUP_S3_BUCKET: "bk",
  BACKUP_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  BACKUP_S3_SECRET_ACCESS_KEY: "secret-example",
  BACKUP_S3_PREFIX: "tm/",
  BACKUP_S3_KEEP: "2",
  BACKUP_PASSPHRASE: PASS,
});

describe("backup encryption", () => {
  it("round-trips and refuses a wrong passphrase or tampering", () => {
    const enc = encryptBackup(Buffer.from("hello database"), PASS);
    expect(decryptBackup(enc, PASS).toString()).toBe("hello database");
    expect(() => decryptBackup(enc, "wrong passphrase!")).toThrow(/decryption failed/);
    enc[enc.length - 20]! ^= 1;
    expect(() => decryptBackup(enc, PASS)).toThrow(/decryption failed/);
    expect(() => decryptBackup(Buffer.from("nope"), PASS)).toThrow(/not an encrypted/);
  });
});

describe("off-site backups", () => {
  it("requires every S3 variable and a passphrase", () => {
    expect(() => makeTestApp({ BACKUP_S3_BUCKET: "x" })).toThrow(/BACKUP_S3_ENDPOINT/);
    const { BACKUP_PASSPHRASE: _p, ...noPass } = s3Env("/tmp");
    expect(() => makeTestApp(noPass)).toThrow(/BACKUP_PASSPHRASE/);
  });

  it("writes a local copy, uploads it encrypted, keeps N remote copies and records the status", async () => {
    const dir = tmpDir();
    const s3 = fakeS3();
    let now = Date.UTC(2026, 0, 1, 3, 0, 0);
    const t = makeTestApp(s3Env(dir), { fetch: s3.fetchImpl, now: () => now });
    const admin = await setupAdmin(t);
    await addDomain(admin);

    for (let i = 0; i < 3; i++) {
      const s = await runBackup(t.deps);
      expect(s.last_ok).toBe(true);
      now += 3600_000;
    }
    const keys = [...s3.objects.keys()].sort();
    expect(keys).toEqual(["tm/throwaway-20260101-040000.db.gz.enc", "tm/throwaway-20260101-050000.db.gz.enc"]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".db.gz"))).toHaveLength(3);

    // The off-site copy decrypts to a valid database with our data.
    const restored = path.join(dir, "restored.db");
    fs.writeFileSync(restored, gunzipSync(decryptBackup(s3.objects.get(keys[1]!)!, PASS)));
    const db = new Database(restored, { readonly: true });
    expect((db.prepare("select name from domains").get() as { name: string }).name).toBe("mail.example.test");
    db.close();

    const h = await admin.get("/v1/admin/health");
    expect(h.json.backup).toMatchObject({ last_ok: true, offsite: true, last_remote_key: keys[1] });
  });

  it("records a failed upload and alerts admins", async () => {
    const dir = tmpDir();
    const sent: string[] = [];
    const t = makeTestApp(
      { ...s3Env(dir), METRICS_TOKEN: "metrics-token-0123456789" },
      {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).startsWith("https://ntfy.example.test")) {
            sent.push(String(init?.body));
            return new Response("ok");
          }
          return new Response("denied", { status: 403 });
        }) as typeof fetch,
      },
    );
    const admin = await setupAdmin(t);
    const me = t.deps.db.select().from(users).get();
    t.deps.db
      .insert(notifyTargets)
      .values({
        id: newId("ntf"),
        userId: me!.id,
        kind: "ntfy",
        name: "alerts",
        url: "https://ntfy.example.test/topic",
        eventsJson: JSON.stringify(["system.alert"]),
        createdAt: Date.now(),
      })
      .run();
    const r = await admin.post("/v1/admin/backup/run");
    expect(r.status).toBe(502);
    expect(r.json.backup.last_ok).toBe(false);
    expect(r.json.backup.last_error).toMatch(/HTTP 403/);
    expect(sent[0]).toMatch(/HTTP 403/);
    const m = await t.app.request("/metrics", { headers: { authorization: "Bearer metrics-token-0123456789" } });
    const text = await m.text();
    expect(text).toContain("throwaway_backup_last_run_ok 0");
    expect(text).toMatch(/throwaway_backups_total\{result="error"\} \d+/);
  });
});

describe("end-to-end probe", () => {
  it("parses SMTP URLs", () => {
    expect(parseSmtpUrl("smtps://u%40x:p@smtp.example.test")).toEqual({
      host: "smtp.example.test",
      port: 465,
      security: "tls",
      user: "u@x",
      password: "p",
    });
    expect(parseSmtpUrl("smtp://relay.test:25?insecure=1")).toMatchObject({ port: 25, security: "none", user: null });
  });

  it("sends, sees the mail arrive, then fails when it stops arriving or cannot be sent", async () => {
    const mail = fakeMail();
    let now = Date.now();
    const t = makeTestApp({ PROBE_SMTP_URL: "smtp://user:pw@relay.example.test:587" }, { mail: mail.clients, now: () => now });
    const admin = await setupAdmin(t);
    await addDomain(admin, "mail.example.test", "auto_create");

    expect(await probeTick(t.deps)).toBe("idle");
    expect(
      (
        await admin.req("PUT", "/v1/admin/probe", {
          enabled: true,
          address: "probe@mail.example.test",
          interval_minutes: 30,
          timeout_minutes: 5,
        })
      ).status,
    ).toBe(200);

    expect(await probeTick(t.deps)).toBe("sent");
    expect(mail.smtp.sent).toHaveLength(1);
    expect(mail.smtp.sent[0]!.to).toEqual(["probe@mail.example.test"]);
    expect(await probeTick(t.deps)).toBe("waiting");

    // The relay delivers it back through ingest.
    const raw = mail.smtp.sent[0]!.raw;
    expect((await ingest(t, "probe@mail.example.test", raw)).status).toBe(200);
    now += 30_000;
    expect(await probeTick(t.deps)).toBe("ok");
    let h = (await admin.get("/v1/admin/health")).json;
    expect(h.probe).toMatchObject({ enabled: true, last_ok: true, consecutive_failures: 0, pending: null });
    expect(h.counts.messages).toBe(0); // the probe mail is deleted once seen

    // Not yet due again.
    expect(await probeTick(t.deps)).toBe("idle");
    now += 30 * 60_000;
    expect(await probeTick(t.deps)).toBe("sent");
    now += 6 * 60_000;
    expect(await probeTick(t.deps)).toBe("failed");
    h = (await admin.get("/v1/admin/health")).json;
    expect(h.probe).toMatchObject({ last_ok: false, consecutive_failures: 1 });
    expect(h.probe.last_error).toMatch(/not received within 5 min/);

    // A relay error fails right away.
    now += 30 * 60_000;
    mail.smtp.failWith = new SmtpError("550 relay denied", true);
    expect(await probeTick(t.deps)).toBe("failed");
    expect((await admin.get("/v1/admin/health")).json.probe.consecutive_failures).toBe(2);
  });

  it("validates the configuration", async () => {
    const t = makeTestApp({ PROBE_SMTP_URL: "smtp://relay.example.test" });
    const admin = await setupAdmin(t);
    expect(
      (await admin.req("PUT", "/v1/admin/probe", { enabled: true, address: "nope", interval_minutes: 30, timeout_minutes: 5 })).status,
    ).toBe(400);
    expect(
      (await admin.req("PUT", "/v1/admin/probe", { enabled: true, address: "a@b.test", interval_minutes: 10, timeout_minutes: 10 })).status,
    ).toBe(400);
    const user = await inviteUser(t, admin, "u@example.org");
    expect(
      (await user.req("PUT", "/v1/admin/probe", { enabled: false, address: "", interval_minutes: 30, timeout_minutes: 5 })).status,
    ).toBe(403);
  });
});
