# Configuration

All settings are environment variables, usually in `.env` next to `docker-compose.yml` (see `.env.example`).

| Variable                            | Default                             | Meaning                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_DOMAIN`                        | `localhost`                         | Hostname Caddy serves (Compose only)                                                                                                                                           |
| `APP_URL`                           | `https://$APP_DOMAIN`               | Primary public URL (SSO redirect URI, OpenAPI)                                                                                                                                 |
| `APP_EXTRA_URLS`                    | empty                               | Other public URLs of the same app; register `<url>/v1/auth/oidc/callback` for each in the IdP                                                                                  |
| `INGEST_SECRET`                     | dev value                           | HMAC secret shared with the Worker (required in production when Cloudflare is configured; without it `/ingest` is disabled)                                                    |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID`     |                                     | Cloudflare credentials; optional when every domain uses an IMAP/SMTP mailbox                                                                                                   |
| `APP_SECRET`                        | unset                               | 32+ characters; encrypts IMAP/SMTP passwords stored in the database (required for IMAP domains). Keep it stable: changing it makes stored passwords unreadable (re-enter them) |
| `WORKER_NAME`                       | `throwaway-mail-ingest`             | Worker the catch-all rules point to                                                                                                                                            |
| `CF_MOCK`                           | `0`                                 | `1` = fake Cloudflare                                                                                                                                                          |
| `RETENTION_DAYS`                    | `30`                                | Message retention, `0` = forever                                                                                                                                               |
| `MAX_INGEST_BYTES`                  | 25 MB                               | Larger mails get 413 (the Worker then uses its fallback)                                                                                                                       |
| `RATE_LIMIT_PER_MINUTE`             | `240`                               | Per API key / user / IP                                                                                                                                                        |
| `LOGIN_RATE_LIMIT_PER_MINUTE`       | `10`                                | Per IP on sign-in endpoints (SSO, password, setup, invites)                                                                                                                    |
| `SESSION_TTL_DAYS`                  | `14`                                | Browser session lifetime                                                                                                                                                       |
| `LOCAL_LOGIN`                       | `auto`                              | Local accounts: `auto` (only without SSO), `true` (with SSO too), `false` (SSO only)                                                                                           |
| `OIDC_ISSUER`, `OIDC_CLIENT_SECRET` |                                     | SSO provider and client secret (optional; required when `LOCAL_LOGIN=false`)                                                                                                   |
| `OIDC_CLIENT_ID`                    | `throwaway-mail`                    | SSO client id                                                                                                                                                                  |
| `OIDC_ADMIN_GROUP`                  | `admins`                            | IdP group mapped to the admin role                                                                                                                                             |
| `OIDC_ALLOWED_GROUPS`               | empty                               | Comma-separated groups allowed to sign in                                                                                                                                      |
| `OIDC_PROVIDER_NAME`                | `Authelia`                          | Label of the sign-in button                                                                                                                                                    |
| `APP_PORT`                          | `3310`                              | Host port (127.0.0.1) when behind your own proxy                                                                                                                               |
| `LOG_LEVEL`                         | `info`                              | Codes and bodies are never logged above `debug`                                                                                                                                |
| `BACKUP_KEEP_DAYS`                  | `14`                                | Backup rotation                                                                                                                                                                |
| `PARSER_LLM_FALLBACK`               | `0`                                 | Enables the (stub) LLM fallback hook                                                                                                                                           |
| `METRICS_TOKEN`                     | unset                               | Enables `GET /metrics` for `Authorization: Bearer <token>` (16+ characters)                                                                                                    |
| `COOKIE_SECURE`                     | auto                                | Force secure cookies on/off (default: on when `APP_URL` is https)                                                                                                              |
| `DATA_DIR` / `DATABASE_PATH`        | `./data` / `$DATA_DIR/throwaway.db` | Storage                                                                                                                                                                        |

## Worker settings

Set in `worker/wrangler.local.toml` (git-ignored copy of `wrangler.toml`):

| Variable            | Meaning                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `APP_URL`           | Public URL of the app (no trailing slash)                                                     |
| `FALLBACK_FORWARD`  | Verified mailbox(es) used when the app is unreachable: one address or `domain=addr,*=default` |
| `INGEST_TIMEOUT_MS` | Time to wait for the app before falling back (default 5000)                                   |
| `INGEST_SECRET`     | Secret (`wrangler secret put`), same value as in the app                                      |
| `SEND_EMAIL`        | `send_email` binding, needed only for PGP-encrypted forwarding                                |
