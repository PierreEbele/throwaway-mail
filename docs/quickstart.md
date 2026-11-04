# Quickstart

About five minutes from an empty VPS to a working address, assuming you already own a domain. The full guide is
[Installation](installation.md).

## 1. Start the container

```bash
sudo mkdir -p /opt/throwaway-mail && cd /opt/throwaway-mail
BASE=https://raw.githubusercontent.com/PierreEbele/throwaway-mail/main
sudo curl -fsSL $BASE/docker-compose.example.yml -o docker-compose.yml
sudo curl -fsSL $BASE/.env.example -o .env
sudo curl -fsSLO $BASE/Caddyfile        # only for the bundled Caddy
```

Edit `.env` and set at least:

```bash
APP_DOMAIN=mail-app.example.com      # where the web UI is served
INGEST_SECRET=...                    # openssl rand -hex 32
APP_SECRET=...                       # openssl rand -hex 32, required for IMAP domains
```

Point an `A` record for `APP_DOMAIN` at the server (DNS only, grey cloud, if it is on Cloudflare), then:

```bash
sudo docker compose --profile caddy up -d    # bundled Caddy with automatic TLS
# or, behind your own reverse proxy (app on 127.0.0.1:3310):
sudo docker compose up -d
```

The image is `ghcr.io/pierreebele/throwaway-mail` (pin a release with `TM_VERSION=1.2`). Open `https://APP_DOMAIN`:
the first visit creates the first admin account.

## 2. Receive mail

Pick one of the two ways.

### Option A: Cloudflare Email Routing

The mail domain must use Cloudflare DNS.

1. Create an API token with the scopes listed in [Installation](installation.md#2-cloudflare-token) and set
   `CF_API_TOKEN` and `CF_ACCOUNT_ID` in `.env`, then `sudo docker compose up -d`.
2. Deploy the Email Worker once:

   ```bash
   git clone https://github.com/PierreEbele/throwaway-mail && cd throwaway-mail/worker
   pnpm install
   pnpm exec wrangler login
   cp wrangler.toml wrangler.local.toml     # set APP_URL (and FALLBACK_FORWARD) here
   pnpm exec wrangler secret put INGEST_SECRET -c wrangler.local.toml   # same value as in .env
   pnpm exec wrangler deploy -c wrangler.local.toml
   ```

   The Worker name must equal `WORKER_NAME` in `.env` (default `throwaway-mail-ingest`).

3. **Admin → Domains → Add domain**: the app enables Email Routing and points the catch-all at the Worker.

### Option B: catch-all IMAP mailbox

No Cloudflare and no Worker. You need a mailbox that receives every address of the domain, with IMAP (and SMTP for
forwarding) and an app password. `APP_SECRET` must be set.

**Admin → Domains → Add domain**, choose _IMAP + SMTP mailbox_, enter server, login and password. The domain turns
**active** once the connection test passes; the mailbox is polled every 60 seconds by default.

## 3. Check the setup

Open **Admin → Setup check** (or run `sudo docker compose exec app node dist/doctor.js`). It lists what is still
missing or misconfigured, with a fix for each item. Then create an address, send it a test mail and watch it appear
in the inbox.

Next steps: [add a destination](installation.md#6-add-a-destination) to forward mail to your real mailbox,
[single sign-on](installation.md#4-accounts-and-single-sign-on), and the [user guide](user-guide.md).
