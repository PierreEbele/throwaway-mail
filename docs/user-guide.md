# User guide

Everything you can do from the web UI. Each feature is also available through the [API](api.md) and the
[Node.js SDK](../sdk/README.md).

- [Addresses](#addresses)
- [Organising: categories, pins, smart folders](#organising)
- [Reading mail](#reading-mail)
- [Forwarding](#forwarding)
- [Leaks and protection](#leaks-and-protection)
- [Notifications](#notifications)
- [On-the-fly addresses](#on-the-fly-addresses)
- [Feeds](#feeds)
- [This week (digest)](#this-week)
- [Account tools](#account-tools)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Addresses

One address per website. **+ New** (or `n`) asks for the site name and, optionally, its URL, a category, a domain,
forwarding and an expiry. The local part is a readable random string such as `amber-otter-4821`.

Right-click an address in the list for quick actions: open, copy, mark read, pin, edit, move to a category, pause,
archive, delete.

- **Pause** rejects new mail; **Archive** also hides the address from the lists; **Delete** removes it with its mail.
- **Expiry**: an address can expire after a number of days. A banner appears three days before, with
  _+7 days_, _+30 days_ and _Never expire_, and a notification is sent 24 hours before.
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
  - **ntfy**: full topic URL, optional access token.
  - **Gotify**: server URL and application token.
  - **Telegram**: bot token and chat id.
  - **Webhook**: any URL, JSON body signed with HMAC-SHA256 (see [API → webhooks](api.md#webhooks)).

  Choose the events: verification codes (the code is in the title), every mail, possible leaks, address about to
  expire, address burned. _Test_ sends a sample. Private or LAN URLs are reserved to admins.

## On-the-fly addresses

Reserve a **directory** name (Account → _On-the-fly addresses_), e.g. `alex`. Then give out
`alex.anything@your-domain` anywhere, even on paper: the address is created for site `anything` when its first mail
arrives, sorted by your category keywords. Up to five directories per user; names are first come, first served.

## Feeds

On an address page, **Private RSS / JSON feed** gives `/feeds/<token>.rss` and `/feeds/<token>.json` with the latest 50
mails (code in the title). Anyone with the link can read them; _Rotate_ invalidates the old links.

## This week

**This week** in the sidebar summarises the last 1, 7 or 30 days: possible leaks, busiest addresses, addresses
expiring soon, new addresses, addresses silent for 30 days, and the leak history.

## Account tools

- **Export / import** JSON of addresses and categories (no mail). _Export encrypted_ protects the file with a
  passphrase (PBKDF2 + AES-256-GCM, done in the browser). Import skips existing addresses and unknown domains.
- **Panic button**: pause every active address at once; _Undo_ resumes exactly those. A category's settings also
  have _Pause all_.
- **API keys** for scripts, the extension and Bitwarden.
- **Two-factor authentication** (local accounts, optional): _Account → Two-factor authentication_. Confirm your
  password, scan the QR code with an authenticator app (or type the key), then enter a code to turn it on. Save the
  ten one-time recovery codes shown once; _New recovery codes_ replaces them. Signing in then asks for a 6-digit code
  (or a recovery code) after the password. _Turn off_ needs your password or a code. If you lose both the app and the
  codes, an admin can _Reset 2FA_ on the Users page. SSO accounts use their identity provider's two-factor settings.
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
