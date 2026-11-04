# API

REST API under `/v1`, authenticated with `Authorization: Bearer tm_…` (API keys) or the browser session. The full,
always up-to-date reference is generated from the code: `https://APP_DOMAIN/docs` (OpenAPI JSON at `/openapi.json`).

- [Getting started (curl)](#getting-started)
- [Node.js SDK](#nodejs-sdk)
- [Endpoint overview](#endpoint-overview)
- [Live events](#live-events)
- [Sending new mail](#sending-new-mail)
- [Webhooks](#webhooks)
- [Feeds](#feeds)
- [Compatibility endpoints](#compatibility-endpoints)

## Getting started

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

Options: `"category":"Dev"` (by name, with `"create_category":true` to create it), `"domain":"other.example"`, `"local_part":"github"`, `"forward":true`, `"destination_id":"dst_…"`, `"expires_in_days":7`.

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

## Node.js SDK

`sdk/` contains `@throwaway-mail/sdk`, a typed, dependency-free client for Node.js 18+. See [sdk/README.md](../sdk/README.md).

```ts
import { ThrowawayMail } from "@throwaway-mail/sdk";

const tm = new ThrowawayMail({ baseUrl: process.env.TM!, apiKey: process.env.KEY! });
const addr = await tm.addresses.create({ site: "github.com", category: "Dev", createCategory: true });
const { code } = await tm.addresses.waitForCode(addr.id, { since: Date.now(), timeoutMs: 120_000 });
```

## Endpoint overview

| Area          | Endpoints                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Addresses     | `GET/POST /v1/addresses`, `GET/PATCH/DELETE /v1/addresses/:id`, `POST /v1/addresses/bulk`                                                                           |
| Filters       | `q`, `site`, `domain`, `status`, `category` (id or `none`), `pinned`, `unread`, `has_code`, `since_hours`, `leak`, `hide_hidden`                                    |
| Messages      | `GET /v1/addresses/:id/messages`, `GET/PATCH/DELETE /v1/messages/:id`, `POST /v1/addresses/:id/messages/bulk`, `GET /v1/addresses/:id/code`                         |
| Newsletters   | `POST /v1/messages/:id/unsubscribe`                                                                                                                                 |
| Protection    | `POST /v1/addresses/:id/senders`, `/replace`, `/extend`, `/feed`; `POST /v1/panic`                                                                                  |
| Rejections    | `POST /v1/addresses/:id/rejected` `{replace}`, `GET /v1/site-rejections`, `DELETE /v1/site-rejections/:id`, `GET /v1/sites/domain`, `GET /v1/admin/site-rejections` |
| Preferences   | `PATCH /v1/auth/me/preferences` `{domain_choice, no_mail_warn_minutes}`; `POST /v1/addresses` accepts `preferred_domain` and returns `avoided_domains`              |
| Insights      | `GET /v1/addresses/:id/stats`, `GET /v1/digest`, `GET /v1/leaks`, `POST /v1/leaks/block`, `GET/POST /v1/stale-addresses`                                            |
| Organisation  | `/v1/categories` (+ `/reorder`), `/v1/saved-searches`, `/v1/directories`                                                                                            |
| Forwarding    | `/v1/destinations` (+ `/refresh`, `/resend`, PGP key via `PATCH`)                                                                                                   |
| Replies       | `PATCH /v1/addresses/:id` `{replies_enabled}`, `GET /v1/addresses/:id/contacts`, `PATCH/DELETE /v1/addresses/:id/contacts/:cid`                                     |
| Rules         | `GET/POST /v1/rules`, `PATCH/DELETE /v1/rules/:id`, `POST /v1/rules/reorder` `{ids}`, `POST /v1/rules/test`                                                         |
| Quarantine    | `GET /v1/quarantine`, `POST /v1/quarantine/:id/release` `{forward}`, `DELETE /v1/quarantine/:id`                                                                    |
| Deliveries    | `GET /v1/delivery-failures` (`status`, `kind`, `address_id`, `destination`, `before`, `limit`), `POST /:id/retry`, `POST /:id/dismiss`                              |
| Fallbacks     | `PUT /v1/forwarding/fallbacks` `{destination_ids}`, `PUT /v1/addresses/:id/fallbacks` `{destination_ids}`                                                           |
| Headers       | `GET/PUT /v1/forwarding/headers` `{allowlist: string[] \| null}`; `GET /v1/messages/:id` returns `raw_headers`                                                      |
| Sending       | `POST /v1/addresses/:id/send`, `GET /v1/sending`, `POST /v1/sending/passwords`, `DELETE /v1/sending/passwords/:id`                                                  |
| Notifications | `/v1/notify-targets` (+ `/test`, `/resume`, `GET /:id/deliveries`, `POST /:id/deliveries/:did/resend`)                                                              |
| Account       | `/v1/keys`, `GET /v1/export`, `POST /v1/import`                                                                                                                     |
| Admin         | `/v1/domains`, `/v1/admin/users` (+ `DELETE /:id/2fa`), `/v1/admin/audit`, `/v1/admin/health`, `/v1/admin/diagnostics`                                              |
| Two-factor    | `GET /v1/auth/2fa`, `POST /v1/auth/2fa/setup`, `/enable`, `/disable`, `/recovery-codes`; `POST /v1/auth/login/2fa`                                                  |

### Rules

A rule is `{name, match: "all" | "any", conditions: [...], actions: [...], address_id?, category_id?}`. Condition
types: `sender` (`op`: `is`/`contains`/`ends_with`, `value`), `sender_domain`, `subject_contains`,
`recipient_matches` (regular expression, max 200 characters, no nested quantifiers / back-references / look-arounds),
`category`, `has_attachments`, `size_over_kb`, `header_exists` (`name`), `header_equals` (`name`, `value`),
`auth_failed` (`value`: `any`/`spf`/`dkim`/`dmarc`), `is_newsletter`, `has_code`; each takes `negate: true`. Action
types: `block`, `quarantine`, `strip_attachments`, `forward_to` (`destination_id`), `set_category` (`category_id`),
`mark_read`, `block_sender`, `pause_address`, `stop`.

```bash
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" $TM/v1/rules -d '{
  "name": "Quarantine forged mail", "match": "any",
  "conditions": [{"type":"auth_failed","value":"dmarc"}, {"type":"subject_contains","value":"urgent payment"}],
  "actions": [{"type":"quarantine"}]}'
```

Messages carry `matched_rules` (`[{id, name}]`), `quarantined_at` and, in full, `raw_headers` (the original header
section). A mail blocked by a rule is rejected with reason `rule_blocked`.

### Sign-in with two-factor authentication

`POST /v1/auth/login` answers `{"two_factor_required": true, "challenge": "…", "expires_in": 300}` (no session yet)
for accounts with TOTP turned on. Send `POST /v1/auth/login/2fa` with `{"challenge", "code"}` (6-digit TOTP code or a
recovery code) within 5 minutes; a challenge allows 5 attempts. Login-like endpoints answer `429` with `Retry-After`
when the IP or account budget is spent (see `LOGIN_*` in [configuration](configuration.md)).

### Audit log

`GET /v1/admin/audit?limit=&offset=&action=&user_id=&target=&ip=` returns `{entries, total, offset, limit, actions}`,
newest first. `action` is exact, or a prefix when it ends with `.` (`auth.`, `user.`, `invite.`, `domain.`,
`destination.`). Actions include `auth.login`, `auth.login_failed`, `auth.recovery_code_used`, `user.password_changed`,
`user.2fa_enabled`, `user.2fa_disabled`, `user.2fa_recovery_regenerated`, `user.2fa_reset`, `invite.created`,
`domain.added`, `domain.deleted`, `destination.created`, `destination.deleted`.

## Live events

`GET /v1/events` is a Server-Sent Events stream: `message.received` (address, subject, sender, whether it has a code),
`address.created`, `address.updated`, `address.deleted` and `category.changed`.

```bash
curl -s -N -H "Authorization: Bearer $KEY" $TM/v1/events
```

## Sending new mail

`POST /v1/addresses/:id/send` sends a new mail from an active address:

```json
{ "to": ["bob@shop.com"], "cc": [], "bcc": [], "subject": "Order 1234", "text": "Hello", "html": "<p>Hello</p>", "from_name": "Alex" }
```

`to` may be a single string. A recipient may be the reverse address (`r+…@domain`) of one of the address's contacts:
it stands for the contact. Every recipient becomes a contact, so answers come back through the alias. Answer:
`{"sent": {"address_id", "from", "to", "message_id", "via"}}`. Errors: `403` (address not active, or a contact of
another address), `429` with `Retry-After` (`SEND_RATE_LIMIT_PER_HOUR`), `502` (refused by the outbound server),
`503` (no outbound SMTP for this domain). SDK: `tm.addresses.send(id, { to, subject, text, fromName })`.

The SMTP submission server (see [installation](installation.md#smtp-submission-optional)) applies the same rules.
`GET /v1/sending` returns its settings for mail clients and the user's SMTP passwords; `POST /v1/sending/passwords`
`{name}` creates one and returns it once (`password`); `DELETE /v1/sending/passwords/:id` revokes it.

## Webhooks

A notification target of kind `webhook` receives a `POST` for each subscribed event. Events are written to an outbox
first and delivered from there, so nothing is lost while the endpoint is down.

| Type               | When                                                                        | `data`                                                                             |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `message.received` | A mail was stored                                                           | `address_id`, `address`, `site`, `message_id`, `from`, `subject`                   |
| `code.received`    | A stored mail has a verification code                                       | the same + `code`                                                                  |
| `message.blocked`  | A mail for an existing address was rejected                                 | `address_id`, `address`, `site`, `from`, `reason`                                  |
| `leak.detected`    | Mail from a sender that is not the site (`rejected: true` with a site lock) | `address_id`, `address`, `site`, `from`, …                                         |
| `address.created`  | An address was created (UI, API, on-the-fly, auto-create)                   | `address_id`, `address`, `site`, `site_url`, `label`, `expires_at`, `auto_created` |
| `address.deleted`  | An address was deleted                                                      | `address_id`                                                                       |
| `address.expiring` | An address expires within 24 h                                              | `address_id`, `address`, `site`, `expires_at`                                      |
| `address.expired`  | An address reached its expiry date and was paused                           | `address_id`, `address`, `site`, `expires_at`                                      |
| `address.burned`   | Paused automatically (after a code / after N mails)                         | message fields + `reason`                                                          |
| `message.sent`     | A new mail was sent from an alias (SMTP, web or API)                        | `address_id`, `address`, `site`, `to`, `subject`, `message_id`, `channel`          |
| `forward.failed`   | The SMTP server of an IMAP domain refused a forward for good                | `address_id`, `address`, `site`, `message_id`, `to`, `error`                       |
| `system.alert`     | Failed backup or delivery probe (admins)                                    | depends on the alert                                                               |

`message.blocked` reasons: `address_paused`, `address_archived`, `address_expired`, `sender_blocked`,
`promotional_blocked`, `sender_not_site`. There is no quarantine, hence no `message.quarantined` event. Forwards done
by the Cloudflare Worker are not reported back to the app, so `forward.failed` only covers IMAP domains.

Body (stable: `id`, `type`, `created_at`, `data`; fields may be added, existing ones keep their meaning):

```json
{
  "id": "evt_…",
  "type": "code.received",
  "created_at": 1793700000000,
  "title": "Code 482913",
  "body": "GitHub · Your code",
  "url": "https://…/addresses/adr_…",
  "data": {
    "address_id": "adr_…",
    "address": "amber-otter-4821@mail.example.com",
    "site": "GitHub",
    "message_id": "msg_…",
    "from": "noreply@github.com",
    "subject": "Your code",
    "code": "482913"
  },
  "sent_at": 1793700000000,
  "address_id": "adr_…"
}
```

`sent_at` and the fields of `data` repeated at the top level (only `address_id` shown above) keep receivers written for
earlier versions working; new integrations should read `data`. `id` is the same for every attempt and every resend of
an event: use it to deduplicate (delivery is at least once).

Headers: `x-tm-event` (type), `x-tm-event-id`, `x-tm-delivery` (one id per delivery), `x-tm-timestamp` (seconds, time
of this attempt) and `x-tm-signature` = hex HMAC-SHA256 of `<timestamp>.<raw body>` with the target's signing secret
(shown on the Account page). Verify it before trusting the payload:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, timestamp: string, body: string, signature: string) {
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
}
```

Delivery: a `2xx` answer within 8 seconds is a success. Anything else (other status, timeout, redirect, a host
resolving to a private address) is retried after 30 s, then 1, 2, 4, 8, 16 and 32 minutes (8 attempts), after which
the delivery is `failed`. After 5 failed deliveries in a row the target is paused (`paused_at`) and receives nothing
until `POST /v1/notify-targets/:id/resume` (or `PATCH` with `{"enabled": true}`); its pending deliveries are then
retried. `GET /v1/notify-targets/:id/deliveries?limit=` lists recent deliveries (kept 14 days) with status, attempts,
last HTTP status, error and body; `POST /v1/notify-targets/:id/deliveries/:did/resend` sends one again with the same
event id. `POST /v1/notify-targets/:id/test` queues a `code.received` sample (`data.test = true`) and waits for the
first attempt. The URL is checked again at every attempt; only admins may target private or LAN addresses. SDK:
`tm.notifications.deliveries(id)`, `.resend(id, deliveryId)`, `.resume(id)`.

## Feeds

`POST /v1/addresses/:id/feed` with `{"enabled":true}` returns the address with a `feed_token`; then
`/feeds/<token>.rss` (RSS 2.0) and `/feeds/<token>.json` (JSON Feed 1.1, code and links under `_throwaway`) need no
authentication. `{"enabled":true}` again rotates the token, `false` disables the feed.

## Compatibility endpoints

The SimpleLogin and addy.io alias APIs are implemented for the Bitwarden username generator: see
[bitwarden.md](bitwarden.md).
