# API

REST API under `/v1`, authenticated with `Authorization: Bearer tm_…` (API keys) or the browser session. The full,
always up-to-date reference is generated from the code: `https://APP_DOMAIN/docs` (OpenAPI JSON at `/openapi.json`).

- [Getting started (curl)](#getting-started)
- [Node.js SDK](#nodejs-sdk)
- [Endpoint overview](#endpoint-overview)
- [Live events](#live-events)
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

| Area          | Endpoints                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Addresses     | `GET/POST /v1/addresses`, `GET/PATCH/DELETE /v1/addresses/:id`, `POST /v1/addresses/bulk`                                                   |
| Filters       | `q`, `site`, `domain`, `status`, `category` (id or `none`), `pinned`, `unread`, `has_code`, `since_hours`, `leak`, `hide_hidden`            |
| Messages      | `GET /v1/addresses/:id/messages`, `GET/PATCH/DELETE /v1/messages/:id`, `POST /v1/addresses/:id/messages/bulk`, `GET /v1/addresses/:id/code` |
| Newsletters   | `POST /v1/messages/:id/unsubscribe`                                                                                                         |
| Protection    | `POST /v1/addresses/:id/senders`, `/replace`, `/extend`, `/feed`; `POST /v1/panic`                                                          |
| Insights      | `GET /v1/addresses/:id/stats`, `GET /v1/digest`, `GET /v1/leaks`, `POST /v1/leaks/block`, `GET/POST /v1/stale-addresses`                    |
| Organisation  | `/v1/categories` (+ `/reorder`), `/v1/saved-searches`, `/v1/directories`                                                                    |
| Forwarding    | `/v1/destinations` (+ `/refresh`, `/resend`, PGP key via `PATCH`)                                                                           |
| Replies       | `PATCH /v1/addresses/:id` `{replies_enabled}`, `GET /v1/addresses/:id/contacts`, `PATCH/DELETE /v1/addresses/:id/contacts/:cid`             |
| Notifications | `/v1/notify-targets` (+ `/test`)                                                                                                            |
| Account       | `/v1/keys`, `GET /v1/export`, `POST /v1/import`                                                                                             |
| Admin         | `/v1/domains`, `/v1/admin/users` (+ `DELETE /:id/2fa`), `/v1/admin/audit`, `/v1/admin/health`, `/v1/admin/diagnostics`                      |
| Two-factor    | `GET /v1/auth/2fa`, `POST /v1/auth/2fa/setup`, `/enable`, `/disable`, `/recovery-codes`; `POST /v1/auth/login/2fa`                          |

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

## Webhooks

A notification target of kind `webhook` receives `POST` requests with a JSON body:

```json
{
  "type": "code.received",
  "title": "Code 482913",
  "body": "GitHub · Your code",
  "url": "https://…/addresses/adr_…",
  "sent_at": 1793700000000,
  "address_id": "adr_…",
  "address": "amber-otter-4821@mail.example.com",
  "site": "GitHub",
  "message_id": "msg_…",
  "from": "noreply@github.com",
  "subject": "Your code",
  "code": "482913"
}
```

Event types: `message.received`, `code.received`, `leak.detected`, `address.expiring`, `address.burned`.
Headers: `x-tm-event`, `x-tm-timestamp` (seconds) and `x-tm-signature` = hex HMAC-SHA256 of `<timestamp>.<raw body>`
with the target's signing secret (shown on the Account page). Verify it before trusting the payload:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, timestamp: string, body: string, signature: string) {
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
}
```

## Feeds

`POST /v1/addresses/:id/feed` with `{"enabled":true}` returns the address with a `feed_token`; then
`/feeds/<token>.rss` (RSS 2.0) and `/feeds/<token>.json` (JSON Feed 1.1, code and links under `_throwaway`) need no
authentication. `{"enabled":true}` again rotates the token, `false` disables the feed.

## Compatibility endpoints

The SimpleLogin and addy.io alias APIs are implemented for the Bitwarden username generator: see
[bitwarden.md](bitwarden.md).
