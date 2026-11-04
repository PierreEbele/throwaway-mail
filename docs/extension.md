# Browser extension

The browser extension for Firefox and Chrome/Chromium is **[Aliasfill](https://github.com/PierreEbele/Aliasfill)**, now its own project. It fills sign-up forms with a fake identity and a disposable address for the site, from your own domain or an alias service — and, with a Throwaway Mail server, it is the only provider that also fetches the verification code and pastes it into the page.

To use it with Throwaway Mail:

1. In the app: _API keys → Create_, name it after the browser (`firefox`, `chrome`).
2. Install Aliasfill (see its README), open its settings, pick **Throwaway Mail**, enter the server URL (`https://mail.example.com`) and the key, _Test connection_, choose the preferred domain, _Save_.

Addresses it creates are named after the site (`site_name` = host name) and follow your account's _New addresses_ format and defaults; the extension's own expiry and mail limit override them only when set. The domain is a preference: when a site is known to reject it (see [Sites that reject a domain](user-guide.md#sites-that-reject-a-domain)), the server picks another one.

It uses `POST /v1/addresses`, `GET /v1/addresses?site=<host>` and the long-polled `GET /v1/addresses/:id/code` with a Bearer API key; extensions with host permission are not subject to CORS, so the server needs no change.
