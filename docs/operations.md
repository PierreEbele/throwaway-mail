# Operations

## Updating

```bash
cd /opt/throwaway-mail && git pull && docker compose up -d --build
```

Migrations run at startup. Take a backup first (below). If `docker compose build` complains about buildx, build with
`docker build -t throwaway-mail:latest .` and start with `--no-build`. After a Worker change, redeploy it too
(`pnpm exec wrangler deploy -c wrangler.local.toml` in `worker/`).

## Backup and restore

The database is one SQLite file (WAL mode) in the `data` volume. `scripts/backup.sh` makes a consistent online copy with `sqlite3 .backup`, checks its integrity, gzips it into `/data/backups`, and deletes copies older than `BACKUP_KEEP_DAYS` (14).

Daily at 03:15 via host cron (`sudo crontab -e`):

```
15 3 * * * cd /opt/throwaway-mail && docker compose exec -T app sh scripts/backup.sh >> /var/log/throwaway-backup.log 2>&1
```

Copy backups off the server regularly:

```bash
docker compose cp app:/data/backups ./backups
```

Restore:

```bash
docker compose stop app
docker compose run --rm --no-deps -v "$PWD/backups:/restore:ro" app sh -c \
  'gunzip -c /restore/throwaway-YYYYMMDD-HHMMSS.db.gz > /data/throwaway.db && rm -f /data/throwaway.db-wal /data/throwaway.db-shm'
docker compose start app
```

### Backups made by the app, and off-site copies

Instead of (or as well as) host cron, the app can back itself up: set `BACKUP_INTERVAL_HOURS` (e.g. `24`). Each run
writes the same integrity-checked `throwaway-YYYYMMDD-HHMMSS.db.gz` into `BACKUP_DIR` (`/data/backups`), keeps
`BACKUP_KEEP_DAYS` of them and, when the `BACKUP_S3_*` variables are set, uploads an **encrypted** copy
(`<BACKUP_S3_PREFIX>throwaway-….db.gz.enc`) to S3-compatible storage (Cloudflare R2, Backblaze B2, MinIO, AWS S3),
then deletes all but the `BACKUP_S3_KEEP` newest objects under the prefix. **Admin → Health → Back up now** runs one
immediately; the card shows the last success or failure, and a failure sends a `system.alert` notification to every
admin target subscribed to "Instance alerts".

Encryption happens before upload: AES-256-GCM with a key derived from `BACKUP_PASSPHRASE` by scrypt (N=2^15, r=8,
p=1, random 16-byte salt per file). File layout: `TMBK1\n` | salt (16) | IV (12) | ciphertext | tag (16). The storage
provider never sees the passphrase. **Keep the passphrase somewhere other than the server** (password manager): without
it the off-site copies cannot be read.

Example for R2 (create an API token with Object Read & Write on one bucket):

```
BACKUP_INTERVAL_HOURS=24
BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
BACKUP_S3_BUCKET=throwaway-backups
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_PASSPHRASE=<long random passphrase>
```

The same work is available from the command line inside the container (`dist/backup-cli.js`):

```bash
docker compose exec -T app node dist/backup-cli.js run                 # back up now (local + off-site)
docker compose exec -T app node dist/backup-cli.js list                # list off-site copies
```

Restore from an off-site copy:

```bash
# 1. download + decrypt + decompress into the data volume (refuses to overwrite an existing file)
docker compose exec -T app node dist/backup-cli.js fetch throwaway-mail/throwaway-YYYYMMDD-HHMMSS.db.gz.enc /data/restore.db
# 2. swap it in
docker compose stop app
docker compose run --rm --no-deps app sh -c \
  'mv /data/restore.db /data/throwaway.db && rm -f /data/throwaway.db-wal /data/throwaway.db-shm'
docker compose start app
```

On a new server, where the app is not running yet, download the `.enc` file with any S3 tool (or the provider's web
console) and decrypt it with `BACKUP_PASSPHRASE=... node dist/backup-cli.js decrypt <file.enc> <out.db>`
(or `pnpm exec tsx scripts/backup-cli.ts decrypt …` from a checkout); then place `out.db` as `throwaway.db` in the data
volume as above.

Messages older than `RETENTION_DAYS` (30) are deleted hourly; `0` keeps them forever.

## Setup check

**Admin → Setup check** (`GET /v1/admin/diagnostics`) runs every check below and explains, for each warning or
error, what to do. The same checks run from the command line, and exit with status 1 when one is an error:

```bash
docker compose exec app node dist/doctor.js          # Docker image
pnpm run doctor                                      # from a checkout (reads .env); --json for JSON
```

(`pnpm doctor` without `run` is pnpm's own self-check.)

| Area       | Checks                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App        | `APP_URL` is HTTPS; every public URL answers `/healthz` from the server (a failure is only a warning: hairpin NAT); `APP_SECRET` set; `INGEST_SECRET` not the default and 32+ random characters                                                                |
| Sign-in    | OIDC discovery document reachable and its `issuer` equals `OIDC_ISSUER`; local accounts on/off and whether an admin exists                                                                                                                                     |
| Cloudflare | token active; Email Routing Addresses permission and `CF_ACCOUNT_ID`; the Worker `WORKER_NAME` is deployed (skipped without the optional Workers Scripts permission)                                                                                           |
| Domains    | Cloudflare domains: MX records (public DNS) all point to `*.mx.cloudflare.net`, Email Routing enabled, catch-all sends to the Worker. IMAP domains: IMAP login + folder, SMTP login, last poll error. All: last mail received (warning after 14 days or never) |
| Operations | a backup in `/data/backups` from the last 2 days                                                                                                                                                                                                               |

The IMAP check is the same as the domain's _Check_ button and updates its status.

## Health and monitoring

- `GET /healthz` answers `{"status":"ok"}` when the database is reachable.
- **Admin → Health** shows uptime, database size, row counts, the last mail received per domain (amber after 7 quiet
  days: check MX records and the Worker), missing DNS records, ingest decisions since start, the last run of the
  background jobs and failing notification targets.
- Set `METRICS_TOKEN` (16+ characters) to expose Prometheus metrics at `GET /metrics`
  (`Authorization: Bearer <token>`): `throwaway_ingest_total{action,reason}`, `throwaway_http_requests_total{status}`,
  `throwaway_notifications_total{kind,result}`, `throwaway_rows{kind}`, `throwaway_db_bytes`,
  `throwaway_domain_last_ingest_timestamp_seconds{domain}`, `throwaway_backups_total{result}`,
  `throwaway_backup_last_success_timestamp_seconds`, `throwaway_backup_last_run_ok`, `throwaway_probe_total{result}`,
  `throwaway_probe_last_success_timestamp_seconds`, `throwaway_probe_ok` (backup gauges appear after the first run,
  probe gauges once the probe is enabled). Example alerts: `throwaway_backup_last_run_ok == 0`,
  `time() - throwaway_backup_last_success_timestamp_seconds > 2 * 86400`, `throwaway_probe_ok == 0`.
- Logs are JSON lines: `docker compose logs -f app`. Verification codes and mail bodies are only logged at `debug`.

## Background jobs

| Job              | Every                   | What it does                                                                                       |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| Retention        | 1 hour                  | Deletes mail older than `RETENTION_DAYS` or its category's limit, old sessions, expired site logos |
| Expiry reminders | 10 min                  | Sends `address.expiring` once, 24 h before an address expires                                      |
| Backup           | `BACKUP_INTERVAL_HOURS` | Local copy + encrypted off-site upload (off by default)                                            |
| Delivery probe   | 1 min                   | Sends / checks the end-to-end probe mail when enabled (see below)                                  |

## End-to-end delivery probe

Optional. It proves that mail really flows (MX → Cloudflare / mailbox → Worker → app), which `/healthz` cannot. Set
`PROBE_SMTP_URL` to an SMTP relay that sends to the internet (`smtps://user:pass@smtp.provider:465`, or `smtp://…:587`
with STARTTLS; `PROBE_FROM` sets the sender), then in **Admin → Health → Delivery probe** enter an address of this
instance that stores mail (for example `probe@your-domain` on a domain that auto-creates addresses, or an existing
address without forwarding), an interval and a timeout. Every interval the app sends a mail with a random token in the
subject; if it is not stored within the timeout (or the relay refuses it), the probe fails: the card turns red,
`throwaway_probe_ok` drops to 0 and admins get one `system.alert` notification per outage (and one when it recovers).
Probe mails are deleted as soon as they are seen. **Run now** sends one immediately.

## When the app is unreachable (Worker fallback)

If `/ingest` errors or does not answer within `INGEST_TIMEOUT_MS`, the Worker does not drop the mail:

1. With `FALLBACK_MODE=forward` (default) it forwards it to the address's **last known destinations**, remembered in
   the optional `ROUTES` KV namespace from earlier mail, or else to `FALLBACK_FORWARD` (per domain or a catch-all).
2. Mail forwarded that way is put on the optional `RETRY_QUEUE` (Cloudflare Queues, mails up to 90 KB) and replayed to
   `/ingest` with back-off once the app is back, so it appears in the inbox too (the app deduplicates by Message-ID;
   its decision is ignored since the mail was already forwarded).
3. When nothing could be forwarded (no route, no fallback, `FALLBACK_MODE=reject`, or the destination refused) the
   Worker answers with a **temporary** error: the sending server keeps the mail and retries later.
4. Each fallback is logged (`wrangler tail`, Workers observability) and POSTed as JSON to `ALERT_WEBHOOK` when set.

Destinations used by Cloudflare forwarding must be verified Email Routing destinations. Setup of the optional
bindings is in `worker/wrangler.toml` (commented blocks): `wrangler kv namespace create ROUTES`,
`wrangler queues create throwaway-mail-retry`, then redeploy the Worker.
