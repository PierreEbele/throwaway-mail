# Architecture

```
Sender → MX (Cloudflare) → Email Routing catch-all → Email Worker
                                                      │ POST /ingest: raw MIME + envelope, HMAC-signed
                                                      ▼
                                 Reverse proxy (TLS) → App (Hono API + React UI) → SQLite
                                                      │
                     { action: forward | store_only | reject, forward_to(_all), send, fallback_to }
                                                      ▼
            Worker: message.forward() to each target / SEND_EMAIL.send() for PGP and rewritten copies / setReject()
                    a failed target is replaced by the first fallback_to that accepts it; failures → POST /ingest/report
```

There is no inbound SMTP server and no port 25: Cloudflare receives and forwards, the app stores, parses and decides.
An optional SMTP _submission_ server (`services/submission.ts`, port 587/465, off by default) lets users send new mail
from their aliases; it shares `services/sending.ts` with the compose dialog and `POST /v1/addresses/:id/send`, and
leaves through the same outbound path as reverse-alias replies. Webhook notifications go through a persistent outbox
(`services/webhooks.ts`, table `webhook_deliveries`) retried by a 15-second background job. If the
app is unreachable, the Worker forwards to the address's cached destinations (`ROUTES` KV) or `FALLBACK_FORWARD`,
queues a copy for the app (`RETRY_QUEUE`), or else rejects with a temporary error (see operations.md).

### Second transport: IMAP/SMTP mailbox

```
Sender → provider MX → catch-all mailbox ◀─IMAP poll─ App ─SMTP─▶ destinations
```

A domain with `transport = imap` needs no Cloudflare at all. `services/mailbox/` keeps one interval poller per such
domain (`poll_seconds`, at least 15; IDLE is not used, a short poll is simpler to keep reliable across providers).
Each poll opens the folder, resets `last_uid` when UIDVALIDITY changed, and handles up to 50 messages with a UID above
`last_uid`: the recipient comes from `Delivered-To` / `X-Original-To` / `X-Envelope-To` / `Envelope-To`, else the first
address of the domain in `To` / `Cc` (mail for nobody on the domain is left in place). The message goes through the
same `ingestMessage()` as Worker mail; a `forward` decision is carried out over SMTP (the raw message unchanged, PGP
copies as built by ingest), `reject` simply means no forward (a mailbox cannot bounce). `last_uid` is saved after each
message, then the message is moved to the done folder or deleted. A temporary SMTP error aborts the poll and the
message is retried (ingest deduplicates it); a permanent one (5xx) is logged and skipped. The IMAP and SMTP libraries
(imapflow, nodemailer) sit behind `deps.mail` so tests use in-memory fakes.

Destinations can also be verified by the app itself: a one-time link (`/v1/destinations/verify/<token>`, SHA-256 of the
token stored, valid 48 h) is mailed through the SMTP server of the first active IMAP domain.

## Repository layout

```
app/server/            Hono API (Node 22, SQLite via Drizzle)
  routes/              One file per area: addresses, messages, categories, bulk, lifecycle, senders, insights,
                       newsletters, backup, feeds, notify, smart-folders, directories, stale, domains, admin…
  services/            Business logic used by routes and jobs
    ingest/            index (pipeline), recipients, forwarding (targets, fallbacks, PGP), transform (strip attachments,
                       header allowlist), effects (notifications, self-destruction), auth
    rules/             Rule schema (zod), ReDoS-guarded regex, evaluation and address-level effects
    deliveries         Delivery attempts, fallback logic shared by SMTP senders, failed-deliveries log, retry
    mailbox/           IMAP poller, runner, SMTP forwarding, recipient detection, app-side destination verification
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
2. `r+<token>@domain` is a reverse-alias reply (`services/replies.ts`): checked (verified destination, SPF/DKIM/DMARC),
   stripped of the user's headers and sent from the alias over SMTP; never stored. Otherwise resolve the recipient: known address, directory (`name.site@`), preserved catch-all, or the domain's
   unknown-address policy.
3. Reject paused, archived or expired addresses, blocked senders, blocked newsletters and site-locked leaks.
4. Deduplicate (Message-ID, or body hash within 15 minutes).
5. Parse codes and links, sanitise HTML and remove trackers, read SPF/DKIM/DMARC, flag phishing and leaks.
6. Run the user's rules (`services/rules/`) in order: block (reject `rule_blocked`), quarantine, strip attachments,
   forward to a specific destination, mark read, and address effects (category, blocked sender, pause) after storing.
7. Store the message (with the matched rules, the full header section up to 256 KB, and a raw copy when it is
   quarantined or forwarded: kept 3 days for retries, until release for quarantine), its extracted items and any leak
   event in one transaction.
8. Publish the live event, send notifications, apply self-destruction.
9. Answer the Worker: plain forwards, `send` copies (PGP-encrypted, or changed: reverse alias, attachments removed,
   headers filtered) and the fallback chain. The Worker reports failed forwards to `POST /ingest/report` (signed like
   `/ingest`, envelope fields `report`/`report`); the app records them in `delivery_failures` with a plain-English
   reason. IMAP domains use the same fallback logic over SMTP.
