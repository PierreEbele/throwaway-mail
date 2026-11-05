# User guide

Everything you can do from the web UI. Each feature is also available through the [API](api.md) and the
[Node.js SDK](../sdk/README.md).

- [Addresses](#addresses)
- [Organising: categories, pins, smart folders](#organising)
- [Reading mail](#reading-mail)
- [Forwarding](#forwarding)
- [Sites that reject a domain](#sites-that-reject-a-domain)
- [Leaks and protection](#leaks-and-protection)
- [Notifications](#notifications)
- [On-the-fly addresses](#on-the-fly-addresses)
- [Feeds](#feeds)
- [This week (digest)](#this-week)
- [Account tools](#account-tools)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Install as an app](#install-as-an-app)

## Addresses

One address per website. **+ New** (or `n`) asks for the site name and, optionally, its URL, a category, a domain,
forwarding, an expiry and a maximum number of mails. The local part is a readable random string such as `amber-otter-4821`
unless you choose another format (below).

**Account → New addresses** sets, for your account:

- the **format** of random local parts: readable words and digits (`amber-otter-4821`, the default), random characters
  of a chosen length (6–32), two words (`amber.otter`; digits are added if both are taken), or a **template** such as
  `{word}-{rand6}` with `{word}`, `{randN}` (N random letters/digits), `{digitsN}` and `{site}` (the site name). A
  template must be random enough not to collide (about a word and 4 digits); examples are shown as you type. A taken
  address is never reused: another one is drawn.
- a **default expiry** and **default max mails**, applied to every new address created without one: the _+ New_
  dialog (prefilled, you can clear them for one address), the API and SDK, the browser extension and Bitwarden.

Right-click an address in the list for quick actions: open, copy, mark read, pin, edit, move to a category, pause,
archive, delete.

- **Pause** rejects new mail; **Archive** also hides the address from the lists; **Delete** removes it with its mail.
- **Expiry**: an address can expire after a number of days. A banner appears three days before, with
  _+7 days_, _+30 days_ and _Never expire_, and a notification is sent 24 hours before. Once expired, the address
  is paused automatically (shown as _expired_; its mail is rejected); extending it brings it back.
- **Max mails**: after N mails the address pauses itself (shown as _quota reached_). Both can be set at creation, from
  the API / SDK, as account defaults (_Account → New addresses_), or as defaults for addresses created by the
  extension (its options page, which overrides the account defaults).
- **Silent addresses**: addresses that never received mail after 30 days are suggested for clean-up in the Inbox.

## Organising

- **Categories** live in the sidebar. Drag an address (or a multi-selection) onto a category to move it, or onto
  _No category_. Drag categories to reorder them; pinned categories stay on top.
- **Hide a category** with the eye icon: its addresses disappear from the Inbox but stay in the category itself.
- **Auto-sort keywords** (category settings): a new address whose site name or URL contains one of the words goes
  into that category, including addresses created by Bitwarden, the extension or a directory.
- **Per-category retention**: delete its mail after N days (only shortens the server-wide `RETENTION_DAYS`).
- **Pins** keep an address at the top of every list.
- **Multi-select**: Ctrl/Cmd+click toggles, Shift+click selects a range. The bar above the list moves, pins, marks
  read, archives or deletes the selection.
- **Quick filters** above the list: _Unread_, _Has code_, _Last 24 h_, _Leak_. Combine them with the search box and
  **Save as smart folder** to keep the view in the sidebar.
- **Search** matches the address, site name, URL and label, but also the subject, sender and text of the mail.

## Reading mail

- The address page shows the **latest verification code** in large type with a copy button, and the detected
  confirmation links.
- HTML mail is shown in a sandboxed frame; remote images are never loaded.
- **Trackers**: tracking pixels are removed and tracking parameters (`utm_*`, `fbclid`, `mc_eid`…) stripped from links
  before the mail is stored. The number removed is shown above the mail.
- **Phishing warning**: a red banner appears when the sender's domain imitates the site's (`paypa1.com`,
  `githuh.com`, `paypal-secure-login.com`) or when the mail fails DMARC (or both SPF and DKIM).
- **Newsletters** are labelled. _Unsubscribe_ uses one-click unsubscribe (RFC 8058) when the sender supports it,
  otherwise opens the unsubscribe page. _Unsubscribe & block newsletters_ also turns on newsletter rejection for the
  address.
- **Attachments** are listed (name, type, size) but not stored.
- **Activity** card: mail per week over 12 weeks, mail with a code, top sender domains.

## Forwarding

Per address, **Forward new mail to my mailbox** sends a copy to a verified [destination](installation.md#6-add-a-destination).

- **Several mailboxes**: tick _Also forward to_ for extra destinations.
- **PGP**: a destination with an OpenPGP public key receives an encrypted PGP/MIME copy instead of the original
  (the whole original message, headers included, is encrypted; the subject can be hidden too). Requires the Worker's
  `SEND_EMAIL` binding. If encryption is impossible, nothing is forwarded in clear.
- **Reject newsletters & promotions**: bulk mail without a verification code is rejected.
- **Replies** (reverse alias): with _Reply from this address_ on, each forwarded mail comes _from_ the alias with a
  private reply address `r+<token>@<domain>` per sender in Reply-To. Replying from your mailbox sends the answer from
  the alias to the original sender: your address, name, mail client and IP headers are removed (your address in the
  body is replaced by the alias). Replies are accepted only from your verified destinations and must pass SPF, DKIM or
  DMARC. The _Replies_ card lists the contacts; _Block_ refuses replies to one, _Forget_ invalidates its reply address.
  Needs outbound SMTP: the domain's mailbox SMTP server (IMAP domains) or `SMTP_RELAY_URL` (Cloudflare domains, which
  also send the rewritten copies with the Worker's `SEND_EMAIL` binding). Without it the toggle is disabled and says why.
- **Fallback mailboxes**: when a mailbox refuses a forward (full, deleted, not verified…), the mail goes to the first
  fallback that accepts it. Set the order under **Destinations → Fallback mailboxes**; an address can have its own list
  (_If forwarding fails, try_ on its page), which replaces the account's. Destinations with a PGP key never receive a
  clear copy, and an encrypted copy is never redirected to another mailbox.
- **Original headers in forwarded mail** (**Destinations**): by default a forward keeps every original header. Tick
  _Remove original headers_ to keep only those needed to read and thread the mail (From, To, Cc, Subject, Date,
  Message-ID, In-Reply-To, References, Reply-To and the MIME headers) plus the ones you list. Such a copy is sent as a
  new message from the alias with the sender in Reply-To (Worker `SEND_EMAIL` binding, or SMTP for IMAP domains).
  The message view always shows the full original headers (_Headers_ tab).

## Rules

**Rules** (sidebar, _Filtering_) act on every mail that arrives, after the address's own protections (blocked
senders, newsletter rejection, site lock). They run from top to bottom; a rule applies to all your addresses, to the
addresses of one category, or to one address.

A rule is: **When** _all_ (or _any_) of its conditions are true, **then** do its actions.

| Conditions                                                             | Actions                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Sender address is / contains / ends with                               | **Block it**: the mail is refused (not stored)              |
| Sender's domain (sub-domains included)                                 | **Quarantine it**: stored, not forwarded, see below         |
| Subject contains                                                       | **Remove attachments before forwarding** (stored copy kept) |
| Alias matches a pattern (regular expression, advanced)                 | **Forward to a specific mailbox** instead of the usual one  |
| Address is in a category                                               | **Move the address to a category**                          |
| Has attachments; is larger than N KB                                   | **Mark as read**                                            |
| Has a header; a header equals a value                                  | **Block this sender's domain** for the address from now on  |
| Failed sender checks: SPF, DKIM, DMARC or any (Authentication-Results) | **Pause the address**                                       |
| Is a newsletter or bulk mail; contains a verification code             | **Stop**: the rules below are ignored for this mail         |

Every condition can be reversed (_no (the opposite)_). The actions of every matching rule add up until a _Stop_.
_Test against the last 20 messages_ shows which recent mail the conditions would match, without changing anything.
The message view lists the rules that applied; the Rules page counts the matches.

Patterns are limited to 200 characters, and patterns that could make matching very slow (repeated groups like
`(a+)+`, back-references, look-arounds) are refused.

**Quarantine** lists held mail. _Release & forward_ forwards it now (the app sends it over SMTP: the domain's mailbox
server for IMAP domains, or `SMTP_RELAY_URL`); _Release only_ keeps it in the inbox without forwarding; _Delete_
removes it. The original message of quarantined mail is kept until it is released or deleted.

## Failed deliveries

**Failed deliveries** (sidebar) lists forwards that did not reach a mailbox, with the reason in plain English (not
verified, mailbox full, refused as spam, no such mailbox, SMTP server unreachable…), the fallback that received the
mail instead if any, and the technical detail. Filter by status, kind (_failed_: temporary or unknown, _refused_:
permanent) and mailbox. _Retry_ sends the mail again to that mailbox over SMTP: possible for 3 days (the original is
kept that long) when the app has an outgoing SMTP server for the domain. _Dismiss_ marks it handled. The mail itself
is always kept in the app.

## Sending new mail

You can write to someone first, from any active alias, without waiting for them to mail you. Each recipient becomes a
contact of the alias (see _Replies_ above), so the answer comes back through the alias and can be answered the same
way. The mail leaves from the alias with the display name you choose; headers that identify you (`Received`,
`X-Originating-IP`, `User-Agent`, `X-Mailer`, `Bcc`...) are removed. It needs the same outbound SMTP as replies.

- **In the app**: _New mail_ in the address's _Replies_ card (from name, to, cc, subject, text).
- **Through the API**: `POST /v1/addresses/:id/send` or `tm.addresses.send(id, {...})` (see [API](api.md#sending-new-mail)).
- **From a mail client** (when the admin enabled SMTP submission): on _Account → Send from your aliases_, create an
  SMTP password per device (shown once, revocable). The card shows the server, port and security to use; the user
  name is your account e-mail. The From address must be one of your active aliases, anything else is refused. To
  answer a contact you may also write to its reply address `r+…@domain`.

Sending is limited per hour (shown on the card). Client setup, with the values from the card:

- **Thunderbird**: _Account Settings → Outgoing Server (SMTP) → Add_: server name, port, _Connection security_
  STARTTLS (587) or SSL/TLS (465), _Authentication method_ "Normal password", user name = your account e-mail. Then
  for each alias, _Manage Identities → Add_: the alias as e-mail address, with the new outgoing server.
- **iOS / iPadOS Mail**: _Settings → Apps → Mail → Mail Accounts → Add Account → Other → Add Mail Account_, e-mail =
  the alias. For incoming mail enter your real mailbox (forwarding delivers there); for _Outgoing Mail Server_ enter
  the server, your account e-mail and the SMTP password, then in the account's _SMTP_ settings turn _Use SSL_ on and
  set the port.
- **Android** (Thunderbird for Android / K-9 Mail, FairEmail): add an identity with the alias as address and an
  outgoing server: the server above, port and STARTTLS or SSL/TLS as shown, user name = your account e-mail,
  password = the SMTP password. Gmail's "Send mail as" works too, but first mails a confirmation link to the alias:
  turn forwarding on before adding it.

## Sites that reject a domain

Some sites refuse sign-ups from alias domains. On the address page, **Site rejected it** records the site and the
domain, pauses the address and creates a new one for the same site on another of your domains (copied to the
clipboard). Without another active domain the report is still kept.

- **Per-site memory**: new addresses for that site (from the web UI, the API or the extension) skip the rejected domain
  automatically. In the **+ New** dialog, the domain _Automatic_ shows which domain will be used and warns when the
  site rejected the selected one. Reports are shared across the instance (only the site and the domain, never who reported it).
- **Domain choice** (Account → Domains of new addresses): when no domain is chosen, use the first domain, a random
  one, or rotate through them. Reports can be forgotten there too.
- **No mail yet**: an address that received nothing some minutes after creation (15 by default, set it on the Account
  page, 0 turns it off) is flagged in the list (_no mail yet?_) and on its page: did the site send the code? It may
  reject the domain. The warning only shows during the address's first day.
- Admins see which sites reject which domains under **Admin → Domains**.

## Leaks and protection

An address belongs to one site. When a mail arrives from a sender whose domain does not match the site's (same brand
on another TLD is fine), the address is flagged **leak?** and the event goes into the leak history.

On the address page:

- **Replace the address**: creates a fresh address for the same site with the same settings, pauses the old one,
  copies the new one and opens the site so you can change your e-mail there.
- **Block this sender** (or any domain in the _Senders_ card): its mail is rejected for this address.
- **Trust this sender**: no more warning for that domain (e.g. a payment provider the site uses).
- **Only accept mail from the site** (site lock): other senders are rejected and logged as leaks.
- **Burn after the first code** / **Burn after N mails**: the address pauses itself, ideal for one-shot sign-ups.

**This week → Leak history by sender** groups leaks by sender domain across all your addresses, with
_Block everywhere_.

## Notifications

- **Desktop notifications** (Account): while the app is open in a tab, a system notification shows new mail; mail
  with a code shows the code, and clicking copies it.
- **Push notifications & webhooks** (Account) work with the app closed:
  - **This device** (Web Push): _Enable on this device_ asks the browser for permission and registers it; a code
    then shows up as "Code 123456" on the lock screen, and tapping it opens the address. Works in Chrome, Edge and
    Firefox (desktop and Android) and Safari; on iPhone/iPad, add the app to the Home Screen first (iOS 16.4+) and
    enable it from the installed app. A browser that unsubscribes is paused automatically.
  - **ntfy**: full topic URL, optional access token.
  - **Gotify**: server URL and application token.
  - **Telegram**: bot token and chat id.
  - **Webhook**: any URL (n8n, Zapier, Home Assistant...), JSON body signed with HMAC-SHA256 (see
    [API → webhooks](api.md#webhooks)).

  Choose the events: verification codes (the code is in the title), every mail, possible leaks, address about to
  expire, address burned, and for automation also address created / deleted / expired, mail blocked, mail sent from
  an alias and forward failed. _Test_ sends a sample. Private or LAN URLs are reserved to admins.

  Webhooks are queued and retried while the endpoint is down (for about an hour). _Recent deliveries_ shows each
  delivery with its attempts, HTTP status and body; _Resend_ sends one again. After 5 deliveries in a row fail for
  good, the webhook is paused and says so; _Resume_ turns it back on.

## On-the-fly addresses

Reserve a **directory** name (Account → _On-the-fly addresses_), e.g. `alex`. Then give out
`alex.anything@your-domain` anywhere, even on paper: the address is created for site `anything` when its first mail
arrives, sorted by your category keywords. Up to five directories per user; names are first come, first served.

**Catch-all auto-create** (admins, per domain): set _unknown: auto_create_ and mail to any unknown local part creates
that address on the fly instead of being rejected (Cloudflare and IMAP domains alike). The domain card then lets you
pick the owner of the created addresses (default: the domain owner) and a default category (default: matched from the
sender like any new address).

## Feeds

On an address page, **Private RSS / JSON feed** gives `/feeds/<token>.rss` and `/feeds/<token>.json` with the latest 50
mails (code in the title). Anyone with the link can read them; _Rotate_ invalidates the old links.

## This week

**This week** in the sidebar summarises the last 1, 7 or 30 days: possible leaks, busiest addresses, addresses
expiring soon, new addresses, addresses silent for 30 days, and the leak history.

## Account tools

- **Language**: the interface is available in English and French. It follows your browser language at first visit;
  _Account → Language_ changes it, and the choice is remembered in this browser. Dates and numbers follow the chosen
  language. Messages coming from the server (API errors, setup check details) stay in English.
- **Export / import** JSON of addresses and categories (no mail). _Export encrypted_ protects the file with a
  passphrase (PBKDF2 + AES-256-GCM, done in the browser). Import skips existing addresses and unknown domains.
- **Import from SimpleLogin or addy.io**: upload their alias export, preview, then import onto one of your domains;
  **Export CSV** writes a simple `alias,note,enabled,…` file. See [Import from SimpleLogin and addy.io](import.md).
- **Panic button**: pause every active address at once; _Undo_ resumes exactly those. A category's settings also
  have _Pause all_.
- **API keys** for scripts, the extension and Bitwarden.
- **Two-factor authentication** (local accounts, optional): _Account → Two-factor authentication_. Confirm your
  password, scan the QR code with an authenticator app (or type the key), then enter a code to turn it on. Save the
  ten one-time recovery codes shown once; _New recovery codes_ replaces them. Signing in then asks for a 6-digit code
  (or a recovery code) after the password. _Turn off_ needs your password or a code. If you lose both the app and the
  codes, an admin can _Reset 2FA_ on the Users page. SSO accounts use their identity provider's two-factor settings.
- **Passkeys** (local accounts, optional): _Account → Passkeys → Add a passkey_, confirm your password, then let the
  browser, phone or security key create it. _Sign in with a passkey_ on the sign-in page then signs you in without
  typing your e-mail or password (the device asks for your fingerprint, face or PIN). Tick _Ask for a passkey after my
  password_ to use a passkey as the second factor instead of (or as well as) an authenticator app; recovery codes are
  created if you have none. A passkey only works on the address it was created on (each URL in `APP_URL` /
  `APP_EXTRA_URLS` needs its own). Removing a passkey needs your password or a code; removing the last one turns
  "passkey after password" off. An admin's _Reset 2FA_ also turns it off.
- Repeated wrong passwords or codes lock the account for a while (see `LOGIN_MAX_FAILURES`), even for the right
  password; wait for the time shown and try again.

Admins also see the **Audit log** (sign-ins and failures, password and two-factor changes, invites, users, domains and
destinations), filterable by action group, action and user.

## Keyboard shortcuts

| Key       | Action                                             |
| --------- | -------------------------------------------------- |
| `n`       | New address                                        |
| `/`       | Search                                             |
| `j` / `k` | Next / previous address                            |
| `x`       | Select the open address                            |
| `1`–`9`   | Move the selection (or open address) to category N |
| `0`       | Remove from its category                           |
| `p`       | Pin / unpin                                        |
| `a`       | Archive (restore in the Archived folder)           |
| `h`       | Hide / show the open category in the Inbox         |
| `Esc`     | Clear the selection                                |
| `e`       | Archive the open message                           |
| `Delete`  | Delete the open message                            |

## Install as an app

Throwaway Mail is a progressive web app: install it from the browser (Chrome/Edge: install icon in the address bar or
_Install app_; Android: _Add to Home screen_ / _Install_; iPhone/iPad: Safari → Share → _Add to Home Screen_). It
then opens in its own window with its icon. The service worker only caches the application itself (HTML, scripts,
icons) so it starts fast; addresses, mail and codes always come from the server and are never stored by it. On a
phone the address list and an address page are two screens: tap an address to open it, _← Back_ to return.
