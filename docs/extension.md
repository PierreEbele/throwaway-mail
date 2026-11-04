# Aliasfill browser extension (Firefox and Chrome)

`extension/` is **Aliasfill**, the browser extension of this project, for Firefox and Chrome/Chromium (Edge, Brave, Vivaldi…) from one codebase. It fills sign-up forms with a fake identity (name, address, phone, birth date, password, test card) and a **disposable e-mail address for the site**. Originally based on Fable (MIT).

It works **without a Throwaway Mail server**: the address can come from your own catch-all domain, plus-addressing on your mailbox, or an alias service you already use. Only a Throwaway Mail server reads the mail it receives, so verification-code autofill is available with Throwaway Mail only; with any other provider you read the code in your mailbox.

## Address providers

Pick one in the extension settings (⚙ in the popup header) under _Where do addresses come from?_. Until one is set up, identities use `@example.com` addresses and nothing leaves the browser (badge `LOCAL`).

| Provider                      | Creates the address with                                                               | Settings                                        | Self-hosted URL | Codes |
| ----------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------- | ----- |
| **No service** (default)      | nothing: built in the browser, `netflix.k3x9q2@your-domain` or `you+netflix@gmail.com` | catch-all domain + pattern, or your own address | —               | no    |
| **Throwaway Mail**            | `POST /v1/addresses` (Bearer API key)                                                  | server, API key, domain, expiry, max mails      | yes             | yes   |
| **SimpleLogin**               | `POST /api/alias/random/new?hostname=<site>` (`Authentication: <key>`)                 | API key                                         | yes             | no    |
| **addy.io**                   | `POST /api/v1/aliases` (Bearer token)                                                  | API token, alias domain                         | yes             | no    |
| **Firefox Relay**             | `POST /api/v1/relayaddresses/` (`Authorization: Token <key>`)                          | API key                                         | no              | no    |
| **Fastmail Masked Email**     | JMAP `MaskedEmail/set` on `api.fastmail.com`                                           | API token with the _Masked Email_ scope         | no              | no    |
| **Forward Email**             | `POST /v1/domains/<domain>/aliases` (Basic auth, token as user name)                   | API token, domain                               | yes             | no    |
| **DuckDuckGo** _experimental_ | `POST quack.duckduckgo.com/api/email/addresses` (Bearer token)                         | token                                           | no              | no    |

- **No service.** _Catch-all domain_: a domain whose mail server accepts any local part (Cloudflare Email Routing catch-all, Fastmail/Proton/Migadu catch-all…). The pattern takes `{site}` (the site's name, `netflix` for `www.netflix.com`, `bbc` for `shop.bbc.co.uk`) and `{random}` (6 characters); default `{site}.{random}`. _Plus-addressing_: `you+netflix@gmail.com`, supported by Gmail, Outlook, Proton, Fastmail and most providers. Nothing is sent anywhere; _Preview an address_ shows one.
- **DuckDuckGo** has no public API. The extension calls the endpoint DuckDuckGo's own extension uses (also used by Bitwarden's generator); it can break without notice, and there is no read-only endpoint, so _Test connection_ only checks that a token is present. The token is the one DuckDuckGo's extension keeps after you sign in to Email Protection.
- Every provider gets the site's host name (as `hostname`, `generated_for`, `forDomain`, label or description depending on the API) so you can find the alias later; Throwaway Mail also gets the fake name as the label.
- _Test connection_ calls a read-only endpoint (`/api/user_info`, `/api/v1/account-details`, `/api/v1/profiles/`, the JMAP session, `/v1/account`, `/v1/auth/me`). _Save_ stores the settings in the extension's local storage and makes the provider active.

The adapters live in `extension/providers/*.js`; each registers `{ id, name, codes, fields, configured, createAlias, testConnection, waitForCode? }` with `extension/providers/index.js`, which also stores settings (`aliasProvider`, `providerSettings`; Throwaway Mail keeps its `tm*` keys) and builds the address object. Installs from before 2.0 with a Throwaway Mail server keep using it.

## What it does

- **Fill form.** A fresh identity and an address for the open site from the active provider, filled in one click. One address per site and identity; filling again on the same host reuses it. **New identity for every new site** by default.
- **Automatic prompt.** On a page that looks like a sign-up form (new-password field, two password fields, or an e-mail field with sign-up wording), a small card offers _Generate and fill_. _Don’t offer on this site again_ remembers the host.
- **Passwords that fit the site.** The 20-character password is typed as is when the form accepts it. If a field's `maxlength`, `minlength` or `pattern` refuses it, the filler types the closest accepted variant (cut to length keeping an upper case letter, a lower case letter, a digit and a symbol, or letters and digits only) and the identity keeps that password, instead of skipping the field.
- **Names that fit the country.** France, United Kingdom or United States (or random), with common names of that country. Addresses, cities and phone numbers are deliberately fictitious (reserved fiction phone ranges, demo street and town names).
- **Right-click menu.** _Insert a disposable address here_ on any editable field reuses this site's address (or creates one) and inserts it.
- **Bitwarden mode.** Leaves e-mail and password to Bitwarden (its generator, its vault) and fills the rest.
- Nothing is ever submitted.

### With Throwaway Mail only (code autofill)

- **Verification code.** The popup shows a _Verification code_ panel: _Wait for code_ long-polls `GET /v1/addresses/:id/code` (up to 2 × 55 s, the popup must stay open), then _Copy_ or _Paste_. Mails with only a confirmation link show the link.
- **Code pasted automatically.** After a fill, the page waits for the mail (through the background script, 20 s long polls, up to 15 min) and pastes the code as soon as it arrives, even after the site moves to its "enter the code" page.
- **One-time-code autofill.** On a one-time-code field (`autocomplete="one-time-code"`, a name like code/otp/verification/2fa/pin, a 4–8 character numeric field, or 4–8 one-digit boxes), the extension looks up this site's address and its latest code from the last 15 min, then shows a _Fill code 123456_ chip (or fills it directly with _Fill one-time-code fields directly_). Detection is in `extension/otp.js`.
- **Toolbar badge.** The active site's address unread count, or a red `!` if a leak was detected.
- **Address format and defaults** follow your account (_Account → New addresses_); the extension options _New addresses expire after_ / _stop after_ override them when set.

With any other provider these controls are hidden: the popup shows no code panel, the settings explain why, and the content script never polls.

## Permissions

| Permission                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                     | identity, settings and the provider's key, in the browser profile only                                                                                                                                                                                                                                                                                                                                               |
| `activeTab`, `scripting`                      | fill the open tab when you click _Fill form_                                                                                                                                                                                                                                                                                                                                                                         |
| `menus` (`contextMenus` on Chrome)            | the right-click _Insert a disposable address here_                                                                                                                                                                                                                                                                                                                                                                   |
| `alarms`                                      | delete expired identities, refresh the badge                                                                                                                                                                                                                                                                                                                                                                         |
| content script on `http://*/*`, `https://*/*` | detect sign-up forms and (Throwaway Mail) code fields                                                                                                                                                                                                                                                                                                                                                                |
| host access `http://*/*`, `https://*/*`       | fill a tab from the sign-up card (without a popup click, `activeTab` does not apply) and reach the provider's API without CORS. Chrome grants it at install. Firefox treats it as optional: on _Test connection_ / _Save_ the extension asks only for **the chosen provider's API origin** (e.g. `https://app.simplelogin.io/*`; _No service_ asks for none), and the _Allow on all sites_ banner asks for the rest. |

The provider's key is only sent to that provider's API. Extensions with host access are not subject to CORS, so no server needs a change.

## Setup

1. Build both packages: `sh scripts/pack-extension.sh` →
   - `dist/aliasfill-<version>.xpi` (Firefox),
   - `dist/aliasfill-<version>-chrome.zip` (Chrome/Chromium).
2. Install:
   - **Firefox:** `about:debugging#/runtime/this-firefox` → _Load Temporary Add-on_ → pick `extension/manifest.json` (removed at restart). For a permanent install, sign it on addons.mozilla.org (`web-ext sign --channel unlisted`), or use Firefox Developer Edition with `xpinstall.signatures.required=false`.
   - **Chrome/Chromium:** unzip the `-chrome.zip` into a folder you keep, open `chrome://extensions`, enable _Developer mode_, _Load unpacked_ → that folder. Chrome 121 or later.
3. Settings (⚙ in the popup): pick the provider, fill its fields, _Test connection_, _Save_. For Throwaway Mail: _API keys → Create_ in the app (name it after the browser), server `https://mail.example.com`, paste the key, pick the preferred domain. The domain is a preference: when a site is known to reject it (see [Sites that reject a domain](user-guide.md#sites-that-reject-a-domain)), the server picks another one.

Store listing drafts can be kept locally in `extension/store/` (git-ignored, left out of the packages).

## One codebase, two builds

`extension/manifest.json` is the Firefox manifest and the source of truth; `scripts/chrome-manifest.mjs` derives the Chrome one at pack time. The differences:

|                                                         | Firefox                           | Chrome (MV3)                                                                            |
| ------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| Background                                              | `background.scripts` (event page) | `background.service_worker` = `service-worker.js`, which `importScripts` the same files |
| Context menu permission                                 | `menus`                           | `contextMenus`                                                                          |
| `browser_specific_settings` (gecko id, data collection) | yes                               | removed                                                                                 |
| Icons                                                   | `icons/throwaway-mail.svg`        | `icons/throwaway-mail-{16,32,48,128}.png` (Chrome does not render SVG)                  |

The code only uses Firefox's promise-based `browser.*` API. `extension/compat.js`, loaded first everywhere (background, content script, popup, options), is a no-op on Firefox; on Chrome it exposes `browser` as a view of `chrome` with `browser.menus` → `chrome.contextMenus` and `runtime.onMessage` listeners that may answer by returning a Promise (bridged to `sendResponse`). When you edit the extension, keep using `browser.*` and test both builds. A new background script must be listed in both `manifest.json` (`background.scripts`) and `service-worker.js`, and a new provider file in `popup.html` and `options.html` too (a unit test checks it).
