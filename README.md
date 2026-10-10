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

**Features:** single sign-on only (OpenID Connect, e.g. Authelia), with roles from IdP groups · domains shared and managed by the admin from the UI (the app configures Cloudflare) · one address per site, with readable random local parts · automatic extraction of verification codes and magic links (English and French) · long-poll `GET /v1/addresses/:id/code` · per-site forwarding toggle and destination · live inbox (SSE) · sandboxed HTML viewer with remote images blocked · API keys · OpenAPI docs at `/docs` · retention job · backups.

---

## Contents

1. [Quick local try-out](#1-quick-local-try-out)
2. [VPS setup](#2-vps-setup)
3. [Cloudflare: token scopes and DNS](#3-cloudflare-token-scopes-and-dns)
4. [Deploy the Email Worker](#4-deploy-the-email-worker)
5. [Single sign-on (Authelia)](#5-single-sign-on-authelia)
6. [Add a domain](#6-add-a-domain)
7. [Add a destination (personal mailbox)](#7-add-a-destination-personal-mailbox)
8. [API examples](#8-api-examples-curl)
9. [Backup and restore](#9-backup-and-restore)
10. [Development](#10-development)
11. [Configuration reference](#11-configuration-reference)
12. [Firefox extension](#12-firefox-extension-fable--throwaway-mail)

---

## 1. Quick local try-out

Runs everything locally with a mocked Cloudflare and a fake OpenID provider that signs you in as an admin without a password. Domains turn active instantly, and destinations become verified when you press **Check status**.

```bash
pnpm install && pnpm build
pnpm fake-oidc &                       # fake IdP on http://127.0.0.1:3298 (user "dory", group admins)
CF_MOCK=1 OIDC_ISSUER=http://127.0.0.1:3298 OIDC_CLIENT_SECRET=dev-oidc-secret OIDC_ALLOW_INSECURE=1 pnpm start
```

Open http://localhost:3000, press **Sign in**, add a domain (any name), create an address and send it a test mail:

```bash
pnpm simulate --to <address> tests/fixtures/github-device-verification.eml
```

To act as a non-admin, open `http://127.0.0.1:3298/_as?user=alice` before signing in. The fake provider is for development only.

## 2. VPS setup

Any small Linux VPS (1 vCPU, 1 GB RAM is plenty: the app uses about 40 MB and Caddy about 20 MB).

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo git clone <your repo> /opt/throwaway-mail && cd /opt/throwaway-mail
sudo cp .env.example .env && sudo nano .env      # see below
sudo docker compose --profile caddy up -d --build     # bundled Caddy with automatic TLS
```

In `.env` set at least `APP_DOMAIN`, `INGEST_SECRET` (`openssl rand -hex 32`), the `OIDC_*` settings (section 5), and later `CF_API_TOKEN` / `CF_ACCOUNT_ID`. The app starts without Cloudflare credentials; domain and destination actions then show a clear error.

**Behind an existing reverse proxy** (e.g. Caddy on the host): run `docker compose up -d` without the profile. The app listens on `127.0.0.1:${APP_PORT:-3310}`. A host Caddy block:

```
jetable.example.com {
	request_body {
		max_size 26MB
	}
	reverse_proxy 127.0.0.1:3310 {
		flush_interval -1      # SSE and long-poll
	}
}
```

Do **not** put Authelia's `forward_auth` in front of the app: `/ingest` (Cloudflare Worker, HMAC-signed) and the API (Bearer keys) must reach it without an Authelia cookie. The app enforces SSO itself for everything else.

Firewall: open TCP 80 and 443 (and UDP 443 for HTTP/3). Nothing else is needed: no mail ports.

DNS for the app: create an `A` (and `AAAA`) record for `APP_DOMAIN` pointing at the VPS. If that record is on Cloudflare, use **DNS only** (grey cloud) so Caddy can obtain its certificate. If you prefer the orange cloud, set SSL mode to *Full (strict)* after Caddy has its certificate.

Updating:

```bash
cd /opt/throwaway-mail && git pull && docker compose up -d --build
```

If `docker compose build` complains about buildx, build with `docker build -t throwaway-mail:latest .` and start with `--no-build`.

Logs are JSON lines: `docker compose logs -f app`. Health: `https://APP_DOMAIN/healthz`.

## 3. Cloudflare: token scopes and DNS

Every mail domain must use Cloudflare DNS, in the same account as the Worker.

Create an API token (*My Profile → API Tokens → Create custom token*) with:

| Scope | Permission | Used for |
|---|---|---|
| Zone → Zone | Read | find the zone of a domain |
| Zone → Zone Settings | Read | read Email Routing status and required DNS records (**Edit** only if the app must enable Email Routing on a zone that doesn't have it yet) |
| Zone → Email Routing Rules | Edit | read and set the catch-all rule |
| Zone → DNS | Read | report missing MX/SPF records |
| Account → Email Routing Addresses | Edit | create destinations (sends the verification mail), read their state |

Zone resources: *All zones* (or only your mail domains). Account resources: your account. `CF_ACCOUNT_ID` is shown on the dashboard overview page.

If the zone has no Email Routing yet and the token only has Zone Settings: Read, enable Email Routing once from the dashboard (*Email → Email Routing → Get started*) and press **Re-check**; the app then only sets the catch-all rule.

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
- `FALLBACK_FORWARD` should be an address already verified as a Cloudflare destination, or one per domain: `example.com=a@x.com,other.org=b@y.com,*=default@z.com`. When the app is unreachable, errors, or does not answer within 5 seconds, mail goes there. If it is empty, the Worker rejects with a temporary error so the sender gets a bounce instead of silent loss.
- Watch it live with `npx wrangler tail`.

## 5. Single sign-on (Authelia)

Login is SSO only: there are no local passwords, setup tokens or invites. A user is created at their first sign-in. Members of `OIDC_ADMIN_GROUP` (default `admins`) are admins, and the role is re-synced at every sign-in. `OIDC_ALLOWED_GROUPS` can restrict who may sign in; otherwise Authelia's `authorization_policy` decides. Admins can disable a user in **Admin → Users**, which also signs them out and stops their API keys.

1. Generate a client secret and its digest:

   ```bash
   SECRET=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-64)
   docker run --rm authelia/authelia:latest authelia crypto hash generate pbkdf2 --variant sha512 --password "$SECRET"
   ```

2. Add the client to Authelia's `configuration.yml` under `identity_providers.oidc.clients`, then restart Authelia:

   ```yaml
   - client_id: 'throwaway-mail'
     client_name: 'Throwaway Mail'
     client_secret: '$pbkdf2-sha512$...'          # the digest
     public: false
     authorization_policy: 'two_factor'           # or one of your policies
     consent_mode: 'implicit'
     require_pkce: true
     pkce_challenge_method: 'S256'
     redirect_uris:
       - 'https://jetable.example.com/v1/auth/oidc/callback'
     scopes: ['openid', 'profile', 'email', 'groups']
     response_types: ['code']
     grant_types: ['authorization_code']
     userinfo_signed_response_alg: 'none'
     id_token_signed_response_alg: 'RS256'
     token_endpoint_auth_method: 'client_secret_basic'
   ```

3. In the app's `.env`: `OIDC_ISSUER=https://auth.example.com`, `OIDC_CLIENT_ID=throwaway-mail`, `OIDC_CLIENT_SECRET=$SECRET`. The redirect URI is always `APP_URL` + `/v1/auth/oidc/callback`.

Any OpenID Connect provider works the same way (Keycloak, Authentik, Zitadel…); set `OIDC_PROVIDER_NAME` for the button label.

## 6. Add a domain

**Admin → Domains → Add domain**, enter e.g. `mail.example.com`. The app then:

1. finds the Cloudflare zone (the domain itself or a parent zone),
2. enables Email Routing,
3. sets the catch-all rule to *Send to Worker → `WORKER_NAME`*,
4. checks DNS.

Status is **active** when all is in place, **pending** with a list of missing DNS records, or **error** with Cloudflare's message. Fix the problem and press **Re-check**.

**Domains that already use Email Routing.** If the zone already has a catch-all that forwards to a mailbox, the app remembers it before pointing the catch-all at the Worker. Mail to addresses the app doesn't know keeps being forwarded to that mailbox, and also appears under **To sort**. There you can register each address as a site (its past mail moves with it, forwarding stays on), block it, or ignore it. **Stop forwarding** on the domain switches to the policy below. Removing the domain from the app puts the old catch-all back. Your existing literal routing rules are never touched and still win over the catch-all. A catch-all that already sends to another Worker is never overwritten.

Every zone whose catch-all points to the Worker must be added in the app. Mail for a domain the app doesn't know is rejected.

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
pnpm fake-oidc &           # fake SSO provider (set OIDC_ISSUER=http://127.0.0.1:3298, OIDC_CLIENT_SECRET=dev-oidc-secret, OIDC_ALLOW_INSECURE=1)
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
| `APP_URL` | `https://$APP_DOMAIN` | Primary public URL (SSO redirect URI, OpenAPI) |
| `APP_EXTRA_URLS` | empty | Other public URLs of the same app; register `<url>/v1/auth/oidc/callback` for each in the IdP |
| `INGEST_SECRET` | dev value | HMAC secret shared with the Worker (required in production unless `CF_MOCK=1`) |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | | Cloudflare credentials (domain and destination actions fail clearly without them) |
| `WORKER_NAME` | `throwaway-mail-ingest` | Worker the catch-all rules point to |
| `CF_MOCK` | `0` | `1` = fake Cloudflare |
| `RETENTION_DAYS` | `30` | Message retention, `0` = forever |
| `MAX_INGEST_BYTES` | 25 MB | Larger mails get 413 (the Worker then uses its fallback) |
| `RATE_LIMIT_PER_MINUTE` | `240` | Per API key / user / IP |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | `20` | Per IP on SSO login and callback |
| `SESSION_TTL_DAYS` | `14` | Browser session lifetime |
| `OIDC_ISSUER`, `OIDC_CLIENT_SECRET` | | SSO provider and client secret (required in production) |
| `OIDC_CLIENT_ID` | `throwaway-mail` | SSO client id |
| `OIDC_ADMIN_GROUP` | `admins` | IdP group mapped to the admin role |
| `OIDC_ALLOWED_GROUPS` | empty | Comma-separated groups allowed to sign in |
| `OIDC_PROVIDER_NAME` | `Authelia` | Label of the sign-in button |
| `APP_PORT` | `3310` | Host port (127.0.0.1) when behind your own proxy |
| `LOG_LEVEL` | `info` | Codes and bodies are never logged above `debug` |
| `BACKUP_KEEP_DAYS` | `14` | Backup rotation |
| `PARSER_LLM_FALLBACK` | `0` | Enables the (stub) LLM fallback hook |
| `DATA_DIR` / `DATABASE_PATH` | `./data` / `$DATA_DIR/throwaway.db` | Storage |

Design choices and assumptions are recorded in [DECISIONS.md](DECISIONS.md).

## 12. Firefox extension (Fable × Throwaway Mail)

`extension/` is a fork of Fable 1.7.0 (MIT, by Numeriane), a fake-identity form filler. The fork keeps everything Fable does and adds:

- **Real disposable addresses.** With a server and API key configured, *Remplir le formulaire* first creates an address for the open site (`site_name` = host name, label `Fable · <fake name>`) and fills it instead of the `@example.com` address. One address per site and profile; it is reused if you fill again on the same host.
- **Verification code.** The popup then shows a *Code de vérification* panel: *Attendre le code* long-polls `GET /v1/addresses/:id/code` (up to 2 × 55 s, the popup must stay open), then *Copier* or *Coller dans la page* (an `autocomplete="one-time-code"` field, the focused field, a field named like code/otp, or one-digit boxes). Mails with only a confirmation link show the link. Nothing is ever submitted.
- Without configuration it behaves exactly like Fable (badge `LOCAL`).

Setup:

1. In the app: *API keys → Create*, name it `firefox`.
2. Build: `./scripts/pack-extension.sh` → `dist/fable-throwaway-<version>.xpi`.
3. Firefox: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick `extension/manifest.json` (removed at restart). For a permanent install, sign it as *unlisted* on addons.mozilla.org (`web-ext sign --channel unlisted`), or use Firefox Developer Edition with `xpinstall.signatures.required=false`.
4. Extension settings (*Réglages Throwaway Mail* in the popup footer): server `https://mail.example.com`, paste the key, *Tester la connexion*, pick the domain, *Enregistrer*. Firefox asks for access to that server only.

The key is stored in the extension's local storage and only sent to the configured server. The API is reached directly with the Bearer key (no Authelia); Firefox extensions with host permission are not subject to CORS, so the server needs no change.

