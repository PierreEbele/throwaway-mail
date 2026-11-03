# Firefox extension

`extension/` is a fork of Fable 1.7.0 (MIT, by Numeriane), a fake-identity form filler. The fork keeps everything Fable does and adds:

## What it adds

- **Real disposable addresses.** With a server and API key configured, _Remplir le formulaire_ first creates an address for the open site (`site_name` = host name, label `Fable · <fake name>`) and fills it instead of the `@example.com` address. One address per site and profile; it is reused if you fill again on the same host.
- **Verification code.** The popup then shows a _Code de vérification_ panel: _Attendre le code_ long-polls `GET /v1/addresses/:id/code` (up to 2 × 55 s, the popup must stay open), then _Copier_ or _Coller dans la page_ (an `autocomplete="one-time-code"` field, the focused field, a field named like code/otp, or one-digit boxes). Mails with only a confirmation link show the link. Nothing is ever submitted.
- **Automatic prompt.** On a page that looks like a sign-up form (new-password field, two password fields, or an e-mail field with sign-up wording), a small card offers _Générer et remplir_: a fresh identity, a new address for that site, filled in one click. _Ne plus proposer sur ce site_ remembers the host.
- **Code pasted automatically.** After a fill with a disposable address, the page waits for the mail (through the background script, 20 s long polls, up to 15 min) and pastes the code into the code field as soon as it arrives, even after the site moves to its "enter the code" page.
- **"Fill code" chip.** Even without a fill in progress, when a page shows a one-time-code field (`autocomplete="one-time-code"`, a name/id/placeholder like code/otp/verification/2fa, a 4–8 character numeric field, or 4–8 one-digit boxes), the extension looks up this site's address (the current identity's, the pending one, or `GET /v1/addresses?site=<host>` with an exact `site_name` match), fetches the latest code from the last 15 min and shows a small _Remplir le code 123456_ chip under the field; clicking fills it (input/change events).
- **Right-click menu.** _Générer une adresse Throwaway ici_ on any editable field reuses this site's address (or creates one) and inserts it.
- **Toolbar badge.** For the active tab's site, the badge shows the address's unread count, or a red `!` if a leak was detected. Refreshed on tab switch/load and every 2 min.
- **Permissions.** Host access is `http://*/*` + `https://*/*` (not `<all_urls>`): the sign-up prompt and code paste run as content scripts on every web page and the background fills tabs with `scripting` without a click, so per-site access is still required; `file://`/`ftp://` are no longer requested.
- **New identity for every new site** by default; filling again on the same site keeps the same identity.
- The three behaviours can be turned off in the extension settings.
- Without configuration it behaves exactly like Fable (badge `LOCAL`).

## Setup

1. In the app: _API keys → Create_, name it `firefox`.
2. Build: `./scripts/pack-extension.sh` → `dist/fable-throwaway-<version>.xpi`.
3. Firefox: `about:debugging#/runtime/this-firefox` → _Load Temporary Add-on_ → pick `extension/manifest.json` (removed at restart). For a permanent install, sign it as _unlisted_ on addons.mozilla.org (`web-ext sign --channel unlisted`), or use Firefox Developer Edition with `xpinstall.signatures.required=false`.
4. Extension settings (_Réglages Throwaway Mail_ in the popup footer): server `https://mail.example.com`, paste the key, _Tester la connexion_, pick the domain, _Enregistrer_. Firefox asks for access to that server only.

The key is stored in the extension's local storage and only sent to the configured server. The API is reached directly with the Bearer key (no Authelia); Firefox extensions with host permission are not subject to CORS, so the server needs no change.

The extension UI is currently in French.
