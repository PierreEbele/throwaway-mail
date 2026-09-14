# Throwaway Mail

Self-hosted, multi-user disposable e-mail addresses. Give every website its own address, read verification codes from the API or the web UI, and choose per site whether mail is also forwarded to your real mailbox.

```
Sender → MX (Cloudflare) → Email Routing catch-all → Email Worker
                                                      │ POST raw MIME + envelope (HMAC-signed)
                                                      ▼
                                VPS: Caddy (TLS) → App (Hono API + React UI) → SQLite
                                                      │
                       {action: "forward" | "store_only" | "reject", forward_to}
                                                      ▼
                       Worker: message.forward(forward_to) / setReject() / nothing
```

No SMTP server, no port 25, no outbound mail on the VPS. Cloudflare receives and forwards; the app stores, parses and decides.

**Features:** invite-only users with admin/user roles · domains shared and managed by the admin from the UI (the app configures Cloudflare) · one address per site, with readable random local parts · automatic extraction of verification codes and magic links (English and French) · long-poll `GET /v1/addresses/:id/code` · per-site forwarding toggle and destination · live inbox (SSE) · sandboxed HTML viewer with remote images blocked · API keys · OpenAPI docs at `/docs` · retention job · backups.

---

## Contents

1. [Quick local try-out](#1-quick-local-try-out)
2. [VPS setup](#2-vps-setup)
3. [Cloudflare: token scopes and DNS](#3-cloudflare-token-scopes-and-dns)
4. [Deploy the Email Worker](#4-deploy-the-email-worker)
5. [First admin](#5-first-admin)
6. [Add a domain](#6-add-a-domain)
7. [Add a destination (personal mailbox)](#7-add-a-destination-personal-mailbox)
8. [API examples](#8-api-examples-curl)
9. [Backup and restore](#9-backup-and-restore)
10. [Development](#10-development)
11. [Configuration reference](#11-configuration-reference)

---

## 1. Quick local try-out

Runs everything with a mocked Cloudflare: domains turn active instantly, destinations become verified when you press **Check status**.

```bash
CF_MOCK=1 docker compose up -d --build
docker compose logs app | grep setup_token
```

Open https://localhost (Caddy's local certificate, accept the browser warning), go to `/setup`, paste the token. Then add a domain (any name), create an address and send it a test mail:

```bash
pnpm install
NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm simulate --url https://localhost --to <address> tests/fixtures/github-device-verification.eml
```

> **Compose and buildx:** recent Docker Compose versions need buildx ≥ 0.17 for `--build`. With an older buildx, build the image with `docker build -t throwaway-mail:latest .`, then run `docker compose up -d --no-build`.

## 2. VPS setup

Any small Linux VPS (1 vCPU, 1 GB RAM is plenty: the app uses about 40 MB and Caddy about 20 MB).

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo git clone <your repo> /opt/throwaway-mail && cd /opt/throwaway-mail
sudo cp .env.example .env && sudo nano .env      # see below
sudo docker compose up -d --build
```

In `.env` set at least `APP_DOMAIN`, `INGEST_SECRET` (`openssl rand -hex 32`), `CF_API_TOKEN` and `CF_ACCOUNT_ID`.

Firewall: open TCP 80 and 443 (and UDP 443 for HTTP/3). Nothing else is needed: no mail ports.

DNS for the app: create an `A` (and `AAAA`) record for `APP_DOMAIN` pointing at the VPS. If that record is on Cloudflare, use **DNS only** (grey cloud) so Caddy can obtain its certificate. If you prefer the orange cloud, set SSL mode to *Full (strict)* after Caddy has its certificate.

Updating:

```bash
cd /opt/throwaway-mail && git pull && docker compose up -d --build
```

Logs are JSON lines: `docker compose logs -f app`. Health: `https://APP_DOMAIN/healthz`.

## 3. Cloudflare: token scopes and DNS

Every mail domain must use Cloudflare DNS, in the same account as the Worker.

Create an API token (*My Profile → API Tokens → Create custom token*) with:

| Scope | Permission | Used for |
|---|---|---|
| Zone → Zone | Read | find the zone of a domain |
| Zone → Email Routing Rules | Edit | enable Email Routing, set the catch-all rule to the Worker |
| Zone → DNS | Read | report missing MX/SPF records |
| Account → Email Routing Addresses | Edit | create destinations (sends the verification mail), read their state |
| Account → Workers Scripts | Read | optional, not used by the app at runtime |

Zone resources: *All zones* (or only your mail domains). Account resources: your account. `CF_ACCOUNT_ID` is shown on the dashboard overview page.

If enabling Email Routing fails with a permission error (Cloudflare has changed which permission covers that call over time), enable Email Routing once from the dashboard (*Email → Email Routing → Get started*) and press **Re-check**; the app then only sets the catch-all rule.

The DNS records that Email Routing needs (three MX records plus an SPF TXT record) are added by Cloudflare when Email Routing is enabled. The domain page in the app lists any that are missing.

## 4. Deploy the Email Worker

Deployed once; the app points every managed domain's catch-all rule at it.

```bash
cd worker
npm install
npx wrangler login
# edit wrangler.toml: APP_URL = "https://<APP_DOMAIN>", optionally FALLBACK_FORWARD
npx wrangler secret put INGEST_SECRET      # same value as INGEST_SECRET in .env
npx wrangler deploy
```

- The Worker name (`name` in `wrangler.toml`, default `throwaway-mail-ingest`) must equal `WORKER_NAME` in `.env`.
- `FALLBACK_FORWARD` should be an address already verified as a Cloudflare destination. When the app is unreachable, errors, or does not answer within 5 seconds, mail goes there. If it is empty, the Worker rejects with a temporary error so the sender gets a bounce instead of silent loss.
- Watch it live with `npx wrangler tail`.

## 5. First admin

On first start, with no users yet, the app prints a one-time setup token:

```bash
docker compose logs app | grep setup_token
```

Open `https://APP_DOMAIN/setup`, paste the token, choose the admin e-mail and password. The token stops working once the admin exists. For automated installs you can fix it in advance with `SETUP_TOKEN` (16+ characters).

Other users: **Admin → Users & invites → Create invite link**, and send them the link (valid 7 days, single use, optionally locked to an e-mail).

## 6. Add a domain

**Admin → Domains → Add domain**, enter e.g. `mail.example.com`. The app then:

1. finds the Cloudflare zone (the domain itself or a parent zone),
2. enables Email Routing,
3. sets the catch-all rule to *Send to Worker → `WORKER_NAME`*,
4. checks DNS.

Status is **active** when all is in place, **pending** with a list of missing DNS records, or **error** with Cloudflare's message. Fix the problem and press **Re-check**.

*Unknown addresses* policy per domain:

- `reject` (default): mail to addresses that do not exist is rejected.
- `inbox`: kept in an *Unassigned* box owned by the admin who added the domain.
- `auto_create`: the address is created on the fly for that admin, named after the sender's domain (catch-all style).

## 7. Add a destination (personal mailbox)

**Destinations → Add**. Cloudflare sends a verification e-mail to that mailbox. Click its link, then press **Check status**. Only verified destinations receive forwarded mail.

Per site (address), toggle **Forward new mail to my mailbox** and pick the destination (default: your first verified one). The change applies to the next mail. Each mail records whether it was forwarded.

## 8. API examples (curl)

Create a key under **API keys**. It is shown once. Full reference: `https://APP_DOMAIN/docs` (OpenAPI JSON at `/openapi.json`).

```bash
export TM=https://mail-app.example.com
export KEY=tm_xxxxxxxx_...
```

Create an address for a site (random readable local part, first active domain):

```bash
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"site_name":"GitHub","site_url":"github.com"}' $TM/v1/addresses
# {"id":"adr_…","email":"amber-otter-4821@mail.example.com","address":{…}}
```

Options: `"domain":"other.example"`, `"local_part":"github"`, `"forward":true`, `"destination_id":"dst_…"`, `"expires_in_days":7`.

Wait for the verification code (long-poll, up to 60 s; 204 if nothing arrived):

```bash
SINCE=$(date +%s%3N)
# … trigger the sign-up on the website …
curl -s -H "Authorization: Bearer $KEY" "$TM/v1/addresses/adr_…/code?wait=30&since=$SINCE"
# {"code":"593201","confidence":0.82,"alternatives":[],"links":[…],"message_id":"msg_…","received_at":…}
```

`since` accepts epoch milliseconds or seconds, an ISO date, or a message id. `require=code` ignores mails that only contain a link.

Other calls:

```bash
curl -s -H "Authorization: Bearer $KEY" "$TM/v1/addresses?site=github&status=active"        # list / filter (also: domain, q)
curl -s -H "Authorization: Bearer $KEY" $TM/v1/addresses/adr_…/messages                     # inbox
curl -s -H "Authorization: Bearer $KEY" $TM/v1/messages/msg_…                                 # full message + extracted items
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"forward_enabled":true}' $TM/v1/addresses/adr_…                                       # forwarding on
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"site_name":"GitHub (work)","status":"paused"}' $TM/v1/addresses/adr_…                # rename + pause
curl -s -X DELETE -H "Authorization: Bearer $KEY" $TM/v1/addresses/adr_…                     # delete with its messages
curl -s -N -H "Authorization: Bearer $KEY" $TM/v1/events                                      # live events (SSE)
```

Errors always look like `{"error":{"code":"bad_request","message":"…","details":[…]}}`. Rate limits answer `429` with `Retry-After`.

## 9. Backup and restore

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

## 10. Development

Node 22+, pnpm.

```bash
pnpm install
cp .env.example .env       # set CF_MOCK=1 for local work
pnpm dev                   # API on :3000 (tsx watch)
pnpm dev:web               # UI on :5173, proxies /v1 to :3000
pnpm simulate --to <address> tests/fixtures/google-verification-code.eml
pnpm tsx scripts/parse-eml.ts some.eml --debug   # see what the parser extracts
```

Tests:

```bash
pnpm test                  # unit + integration (Vitest): parser fixtures, ingest, API, isolation, worker, Cloudflare client
pnpm build && pnpm exec playwright install chromium && pnpm test:e2e   # UI smoke test
pnpm typecheck
```

Layout:

```
app/server/      Hono API: routes/, services/ (ingest, domains, destinations, retention), parser/, cloudflare/, auth/, db/
app/web/         React + Vite + Tailwind + TanStack Query
worker/          Cloudflare Email Worker (wrangler.toml)
tests/           unit/, integration/, e2e/, fixtures/ (32 real-world .eml files + expected.json)
scripts/         simulate-mail.ts, parse-eml.ts, backup.sh
```

Database migrations live in `app/server/db/migrations` and run at startup. After changing `schema.ts`, run `pnpm db:generate`.

Adding a parser fixture: drop an `.eml` in `tests/fixtures` and add its expected code or link to `expected.json`.

## 11. Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `APP_DOMAIN` | `localhost` | Hostname Caddy serves (Compose only) |
| `APP_URL` | `https://$APP_DOMAIN` | Public URL, used in invite links and OpenAPI |
| `INGEST_SECRET` | dev value | HMAC secret shared with the Worker (required in production unless `CF_MOCK=1`) |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | | Cloudflare credentials (required unless `CF_MOCK=1`) |
| `WORKER_NAME` | `throwaway-mail-ingest` | Worker the catch-all rules point to |
| `CF_MOCK` | `0` | `1` = fake Cloudflare |
| `RETENTION_DAYS` | `30` | Message retention, `0` = forever |
| `MAX_INGEST_BYTES` | 25 MB | Larger mails get 413 (the Worker then uses its fallback) |
| `RATE_LIMIT_PER_MINUTE` | `240` | Per API key / user / IP |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | `10` | Per IP on login, setup and invite acceptance |
| `SESSION_TTL_DAYS` | `14` | Browser session lifetime |
| `SETUP_TOKEN` | random | Fixed first-run token |
| `LOG_LEVEL` | `info` | Codes and bodies are never logged above `debug` |
| `BACKUP_KEEP_DAYS` | `14` | Backup rotation |
| `PARSER_LLM_FALLBACK` | `0` | Enables the (stub) LLM fallback hook |
| `DATA_DIR` / `DATABASE_PATH` | `./data` / `$DATA_DIR/throwaway.db` | Storage |

Design choices and assumptions are recorded in [DECISIONS.md](DECISIONS.md).
