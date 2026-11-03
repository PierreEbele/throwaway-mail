# Installation

From an empty VPS to a working domain. Allow about an hour, most of it waiting for DNS and for Cloudflare's
verification mails.

1. [Server](#1-server)
2. [Cloudflare token](#2-cloudflare-token)
3. [Email Worker](#3-email-worker)
4. [Accounts and single sign-on](#4-accounts-and-single-sign-on)
5. [Add a domain](#5-add-a-domain)
6. [Add a destination](#6-add-a-destination)
7. [Install the extension and Bitwarden integration](#7-browser-extension-and-bitwarden)

## 1. Server

Any small Linux VPS (1 vCPU, 1 GB RAM is plenty: the app uses about 40 MB and Caddy about 20 MB).

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo git clone <your repo> /opt/throwaway-mail && cd /opt/throwaway-mail
sudo cp .env.example .env && sudo nano .env      # see below
sudo docker compose --profile caddy up -d --build     # bundled Caddy with automatic TLS
```

In `.env` set at least `APP_DOMAIN`, `INGEST_SECRET` (`openssl rand -hex 32`), optionally the `OIDC_*` settings ([single sign-on](#4-accounts-and-single-sign-on)), and later `CF_API_TOKEN` / `CF_ACCOUNT_ID`. The app starts without Cloudflare credentials; domain and destination actions then show a clear error.

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

DNS for the app: create an `A` (and `AAAA`) record for `APP_DOMAIN` pointing at the VPS. If that record is on Cloudflare, use **DNS only** (grey cloud) so Caddy can obtain its certificate. If you prefer the orange cloud, set SSL mode to _Full (strict)_ after Caddy has its certificate.

Updating:

```bash
cd /opt/throwaway-mail && git pull && docker compose up -d --build
```

If `docker compose build` complains about buildx, build with `docker build -t throwaway-mail:latest .` and start with `--no-build`.

Logs are JSON lines: `docker compose logs -f app`. Health: `https://APP_DOMAIN/healthz`.

## 2. Cloudflare token

Every mail domain must use Cloudflare DNS, in the same account as the Worker.

Create an API token (_My Profile → API Tokens → Create custom token_) with:

| Scope                             | Permission | Used for                                                                                                                                   |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Zone → Zone                       | Read       | find the zone of a domain                                                                                                                  |
| Zone → Zone Settings              | Read       | read Email Routing status and required DNS records (**Edit** only if the app must enable Email Routing on a zone that doesn't have it yet) |
| Zone → Email Routing Rules        | Edit       | read and set the catch-all rule                                                                                                            |
| Zone → DNS                        | Read       | report missing MX/SPF records                                                                                                              |
| Account → Email Routing Addresses | Edit       | create destinations (sends the verification mail), read their state                                                                        |

Zone resources: _All zones_ (or only your mail domains). Account resources: your account. `CF_ACCOUNT_ID` is shown on the dashboard overview page.

If the zone has no Email Routing yet and the token only has Zone Settings: Read, enable Email Routing once from the dashboard (_Email → Email Routing → Get started_) and press **Re-check**; the app then only sets the catch-all rule.

The DNS records that Email Routing needs (three MX records plus an SPF TXT record) are added by Cloudflare when Email Routing is enabled. The domain page in the app lists any that are missing.

## 3. Email Worker

Deployed once; the app points every managed domain's catch-all rule at it.

```bash
cd worker
pnpm install
pnpm exec wrangler login
cp wrangler.toml wrangler.local.toml       # git-ignored: put your real APP_URL / FALLBACK_FORWARD here
pnpm exec wrangler secret put INGEST_SECRET -c wrangler.local.toml   # same value as INGEST_SECRET in .env
pnpm exec wrangler deploy -c wrangler.local.toml
```

- The Worker name (`name` in `wrangler.toml`, default `throwaway-mail-ingest`) must equal `WORKER_NAME` in `.env`.
- `FALLBACK_FORWARD` should be an address already verified as a Cloudflare destination, or one per domain: `example.com=a@x.com,other.org=b@y.com,*=default@z.com`. When the app is unreachable, errors, or does not answer within 5 seconds, mail goes there. If it is empty, the Worker rejects with a temporary error so the sender gets a bounce instead of silent loss.
- Watch it live with `pnpm exec wrangler tail`.

#### PGP-encrypted forwarding (optional)

A destination can hold an OpenPGP public key (Destinations page). Mail forwarded to it is then wrapped in a
PGP/MIME envelope by the app, and the Worker **sends** that encrypted copy itself instead of forwarding the
original. This needs the `send_email` binding already declared in `worker/wrangler.toml` (`SEND_EMAIL`): redeploy
the Worker after updating. Cloudflare only delivers it to verified destinations. If the binding is missing, the
mail is stored but never forwarded in clear.

The Worker also forwards to several destinations when an address has extra ones (`forward_to_all`).

If `pnpm exec wrangler login` fails in the browser (for example _No CSRF value available in the session cookie_),
create an API token from the **Edit Cloudflare Workers** template and run the commands with it instead. `read -s`
keeps the token out of your shell history:

```bash
read -s CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
pnpm exec wrangler deploy -c wrangler.local.toml
```

## 4. Accounts and single sign-on

Two ways to sign in, chosen with `LOCAL_LOGIN`:

| `LOCAL_LOGIN`    | Local accounts                       | Single sign-on  |
| ---------------- | ------------------------------------ | --------------- |
| `auto` (default) | only when `OIDC_*` is not configured | when configured |
| `true`           | yes                                  | when configured |
| `false`          | no                                   | required        |

The app refuses to start when neither is available. Admins can disable any user in **Admin → Users**, which also
signs them out and stops their API keys.

### Local accounts

E-mail and password, hashed with scrypt.

- **First run**: while there is no user at all, opening the app shows a setup page that creates the first admin.
  It is refused as soon as any user exists.
- **Invites**: in **Admin → Users**, enter an e-mail and a role to get a one-time link (`APP_URL/invite/…`, valid
  7 days). Send it yourself; the app does not e-mail it. Opening it lets the person choose a password and signs
  them in. Pending links can be revoked; creating a new link for the same e-mail replaces the old one.
- **Password reset**: **Reset password** next to a local user creates the same kind of link for their existing
  account. Using it sets a new password and signs out all their sessions. Users change their own password in
  **Account** (other sessions are signed out).
- **Roles** of local accounts are set by admins in **Admin → Users**; the last admin cannot be demoted.
- Password logins share the `LOGIN_RATE_LIMIT_PER_MINUTE` budget per IP.

When both methods are on, a local account and a single sign-on identity are never merged: a single sign-on login
whose e-mail belongs to a local account is refused (`local_account_exists`), and SSO accounts cannot get a password
or an invite. There is no automatic linking: give each person one kind of account.

### Single sign-on

A user is created at their first sign-in. Members of `OIDC_ADMIN_GROUP` (default `admins`) are admins, and the role is re-synced at every sign-in. `OIDC_ALLOWED_GROUPS` can restrict who may sign in; otherwise Authelia's `authorization_policy` decides.

1. Generate a client secret and its digest:

   ```bash
   SECRET=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-64)
   docker run --rm authelia/authelia:latest authelia crypto hash generate pbkdf2 --variant sha512 --password "$SECRET"
   ```

2. Add the client to Authelia's `configuration.yml` under `identity_providers.oidc.clients`, then restart Authelia:

   ```yaml
   - client_id: "throwaway-mail"
     client_name: "Throwaway Mail"
     client_secret: "$pbkdf2-sha512$..." # the digest
     public: false
     authorization_policy: "two_factor" # or one of your policies
     consent_mode: "implicit"
     require_pkce: true
     pkce_challenge_method: "S256"
     redirect_uris:
       - "https://jetable.example.com/v1/auth/oidc/callback"
     scopes: ["openid", "profile", "email", "groups"]
     response_types: ["code"]
     grant_types: ["authorization_code"]
     userinfo_signed_response_alg: "none"
     id_token_signed_response_alg: "RS256"
     token_endpoint_auth_method: "client_secret_basic"
   ```

3. In the app's `.env`: `OIDC_ISSUER=https://auth.example.com`, `OIDC_CLIENT_ID=throwaway-mail`, `OIDC_CLIENT_SECRET=$SECRET`. The redirect URI is always `APP_URL` + `/v1/auth/oidc/callback`.

Any OpenID Connect provider works the same way (Keycloak, Authentik, Zitadel…); set `OIDC_PROVIDER_NAME` for the button label.

## 5. Add a domain

**Admin → Domains → Add domain**, enter e.g. `mail.example.com`. The app then:

1. finds the Cloudflare zone (the domain itself or a parent zone),
2. enables Email Routing,
3. sets the catch-all rule to _Send to Worker → `WORKER_NAME`_,
4. checks DNS.

Status is **active** when all is in place, **pending** with a list of missing DNS records, or **error** with Cloudflare's message. Fix the problem and press **Re-check**.

**Domains that already use Email Routing.** If the zone already has a catch-all that forwards to a mailbox, the app remembers it before pointing the catch-all at the Worker. Mail to addresses the app doesn't know keeps being forwarded to that mailbox, and also appears under **To sort**. There you can register each address as a site (its past mail moves with it, forwarding stays on), block it, or ignore it. **Stop forwarding** on the domain switches to the policy below. Removing the domain from the app puts the old catch-all back. Your existing literal routing rules are never touched and still win over the catch-all. A catch-all that already sends to another Worker is never overwritten.

Every zone whose catch-all points to the Worker must be added in the app. Mail for a domain the app doesn't know is rejected.

_Unknown addresses_ policy per domain:

- `reject` (default): mail to addresses that do not exist is rejected.
- `inbox`: kept in an _Unassigned_ box owned by the admin who added the domain.
- `auto_create`: the address is created on the fly for that admin, named after the sender's domain (catch-all style).

## 6. Add a destination

**Destinations → Add**. Cloudflare sends a verification e-mail to that mailbox. Click its link, then press **Check status**. Only verified destinations receive forwarded mail.

Per site (address), toggle **Forward new mail to my mailbox** and pick the destination (default: your first verified one). The change applies to the next mail. Each mail records whether it was forwarded.

A destination can also hold an OpenPGP public key: see [PGP-encrypted forwarding](#pgp-encrypted-forwarding-optional).

## 7. Browser extension and Bitwarden

See [extension.md](extension.md) and [bitwarden.md](bitwarden.md).

Next: [user guide](user-guide.md), [operations](operations.md).
