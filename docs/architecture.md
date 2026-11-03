# Architecture

```
Sender → MX (Cloudflare) → Email Routing catch-all → Email Worker
                                                      │ POST /ingest: raw MIME + envelope, HMAC-signed
                                                      ▼
                                 Reverse proxy (TLS) → App (Hono API + React UI) → SQLite
                                                      │
                     { action: forward | store_only | reject, forward_to(_all), send }
                                                      ▼
            Worker: message.forward() to each target / SEND_EMAIL.send() for PGP copies / setReject()
```

There is no SMTP server and no port 25: Cloudflare receives and forwards, the app stores, parses and decides. If the
app is unreachable, the Worker forwards to `FALLBACK_FORWARD` or rejects with a temporary error.

## Repository layout

```
app/server/            Hono API (Node 22, SQLite via Drizzle)
  routes/              One file per area: addresses, messages, categories, bulk, lifecycle, senders, insights,
                       newsletters, backup, feeds, notify, smart-folders, directories, stale, domains, admin…
  services/            Business logic used by routes and jobs
    ingest/            index (pipeline), recipients, forwarding, effects (notifications, self-destruction), auth
    addresses, categories, notify, pgp, reminders, retention, metrics, icons, domains, destinations
  lib/                 Pure helpers: senders (leak checks), phishing, trackers, listheaders, outbound, sanitize, time
  parser/              Verification-code and link extraction (English and French), pluggable strategies
  cloudflare/          Live, mock and unconfigured Cloudflare clients
  auth/                OIDC, sessions, API keys, CSRF, rate limiting
  db/                  Drizzle schema and SQL migrations (applied at startup)
app/web/src/           React + Vite + Tailwind + TanStack Query
  pages/mailbox/       Sidebar folders, address list, multi-select, context menu
  pages/address/       Address page: header, cards, banners, message view
  pages/settings/      Destinations, API keys, account cards
worker/                Cloudflare Email Worker
extension/             Throwaway Mail Firefox extension
sdk/                   Node.js SDK (@throwaway-mail/sdk)
tests/                 unit/, integration/ (real app, in-memory SQLite), sdk/, e2e/ (Playwright), fixtures/ (.eml)
scripts/               simulate-mail, parse-eml, backup, fake-idp, pack-extension
```

## Ingest pipeline

1. Verify the HMAC signature and timestamp; reject oversize bodies.
2. Resolve the recipient: known address, directory (`name.site@`), preserved catch-all, or the domain's
   unknown-address policy.
3. Reject paused, archived or expired addresses, blocked senders, blocked newsletters and site-locked leaks.
4. Deduplicate (Message-ID, or body hash within 15 minutes).
5. Parse codes and links, sanitise HTML and remove trackers, read SPF/DKIM/DMARC, flag phishing and leaks.
6. Store the message, its extracted items and any leak event in one transaction.
7. Publish the live event, send notifications, apply self-destruction.
8. Answer the Worker: plain forwards and PGP-encrypted copies.

Design decisions and their reasons are in [DECISIONS.md](../DECISIONS.md).
