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
  `throwaway_domain_last_ingest_timestamp_seconds{domain}`.
- Logs are JSON lines: `docker compose logs -f app`. Verification codes and mail bodies are only logged at `debug`.

## Background jobs

| Job              | Every  | What it does                                                                                       |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Retention        | 1 hour | Deletes mail older than `RETENTION_DAYS` or its category's limit, old sessions, expired site logos |
| Expiry reminders | 10 min | Sends `address.expiring` once, 24 h before an address expires                                      |
