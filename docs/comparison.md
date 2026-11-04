# Comparison with hosted alias services

Facts as of November 2026, taken from the official pages listed under [Sources](#sources). Prices and quotas change
often: check the source before deciding. "unverified" means the official pages we opened did not confirm the fact.

|                              | Throwaway Mail                                    | SimpleLogin                                                    | addy.io                                                                                | Firefox Relay                                                          | DuckDuckGo Email Protection                                   |
| ---------------------------- | ------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| Self-hosting                 | Only option: you run it (Docker, 1 GB VPS)        | Yes, open source and self-hostable; hosted service too         | Yes, self-hostable; hosted service too                                                 | Code is public but depends on Mozilla services (SES, Mozilla Accounts) | No                                                            |
| Free-tier quotas             | No quotas (your server, your domain)              | 10 aliases, 1 mailbox, unlimited bandwidth                     | Unlimited username aliases, 10 random aliases, 1 inbox, 10 MB forwarded mail per month | 5 email masks                                                          | Unlimited addresses, free                                     |
| Replies / sending from alias | Replies yes, through your own outbound SMTP relay | Replies on free; starting new mails (reverse alias) on Premium | Paid plans only (Lite and Pro)                                                         | Paid plans only                                                        | Replies yes; new mails through an address-encoding workaround |
| Custom domains               | Required: you need your own domain                | Premium: unlimited                                             | Lite: 1, Pro: up to 20                                                                 | No own domain; paid plans get a `mozmail.com` subdomain                | No (only `duck.com`)                                          |
| PGP encryption               | Yes, per destination (PGP/MIME)                   | Premium                                                        | Yes (GPG/OpenPGP); plan not stated on the page we opened                               | unverified                                                             | unverified                                                    |
| Open source (license)        | Yes, MIT                                          | Yes, AGPL-3.0                                                  | Yes, AGPL-3.0                                                                          | Yes, MPL 2.0                                                           | unverified                                                    |
| Mobile apps                  | No (web UI, Firefox / Chrome extension, API)      | iOS, Android, F-Droid                                          | iOS and Android                                                                        | unverified                                                             | Built into the DuckDuckGo mobile browsers                     |
| Price                        | Free software; you pay for the VPS and the domain | Premium $4/month or $36/year                                   | Lite $1/month (yearly), Pro $3/month (yearly) or $4 monthly                            | Not shown on the pricing page we opened (waitlist)                     | Free                                                          |

## Where Throwaway Mail is weaker

- **No hosted service.** You need a server, a domain, Docker and either a Cloudflare account or a catch-all IMAP
  mailbox. Nobody else keeps it running, backed up or updated for you.
- **Your own domain is mandatory.** There is no shared alias domain, so every alias points back to a domain you own.
  The hosted services let you hide in a crowd of users on a shared domain.
- **No mobile app.** The web UI works in a mobile browser, but there is no native app.
- **Replies need outbound SMTP.** Sending from an alias requires an SMTP relay you configure yourself; with the IMAP
  mode, forwarded mail can fail SPF/DMARC at strict receivers (see [Installation](installation.md)).
- **Smaller project.** Fewer users, fewer audits and less tooling (password manager integrations, apps) than the
  established services.

## Where it is stronger

- No quotas on addresses, mailboxes or bandwidth, and all data stays on your server.
- Built around one-time verification codes: extraction, long-poll API, browser extension, leak detection.
- MIT license, no paid tier.
- Several domains with per-site memory: when a site rejects one domain, new addresses for it use another.

Coming from SimpleLogin or addy.io? See [Import from SimpleLogin and addy.io](import.md).

## Sources

- SimpleLogin pricing: <https://simplelogin.io/pricing/>
- SimpleLogin source: <https://github.com/simple-login/app>
- addy.io home and pricing: <https://addy.io/>
- addy.io source: <https://github.com/anonaddy/anonaddy>
- Firefox Relay plans: <https://relay.firefox.com/premium/>
- Firefox Relay source: <https://github.com/mozilla/fx-private-relay>
- DuckDuckGo Email Protection:
  <https://duckduckgo.com/duckduckgo-help-pages/email-protection/what-is-duckduckgo-email-protection>
- DuckDuckGo, sending from a Duck Address:
  <https://duckduckgo.com/duckduckgo-help-pages/email-protection/duck-addresses/how-do-i-compose-a-new-email>
