# Public demo

`DEMO_MODE=1` turns an instance into a public demo that anyone can try without an account and without being able to
abuse it.

## What demo mode does

- **One-click sign-in**: the sign-in page only shows _Enter the demo_, which opens a session for the shared demo
  account (an admin, so the admin pages can be visited). Password sign-in, set-up and invites are disabled.
- **Read-only where it matters**: creating, changing or deleting domains, destinations, users, invites, API keys,
  notification targets, on-the-fly directories, passwords and two-factor settings is refused (`403 demo_mode`), as are
  admin actions (backups, probes) and one-click unsubscribe (it would call real sites). Addresses, categories, smart
  folders, mail and the "site rejected it" reports stay editable so the app can be explored.
- **No forwarding**: no mail is ever forwarded, whatever the address settings say.
- **Banner**: every page says it is a public demo and when the next reset happens.
- **Reset from a seed**: at start-up and every `DEMO_RESET_MINUTES` (default 60), every user, domain, address and mail
  is deleted and the seed is loaded again. Visitors are signed out and enter again with one click.

The seed is the data of the documentation screenshots (`tests/screenshots/readme.spec.ts`): Discord, Steam, PayPal,
Amazon, Microsoft and GitHub addresses on `mail.example.test` in the Social, Games, Shopping and Dev categories, each with
a real verification mail from `tests/fixtures` (codes and links are extracted as for real mail). It adds a second domain
with a site that rejected the first one, and a sign-up still waiting for its code (the "no mail yet" warning).

## Hosting a demo

Never enable demo mode on an instance holding real data: **the first reset deletes everything in the database.** Use a
dedicated data volume.

```yaml
# docker-compose.yml of the demo
services:
  app:
    image: ghcr.io/pierreebele/throwaway-mail:latest
    restart: unless-stopped
    environment:
      APP_URL: https://demo.example.com
      DEMO_MODE: "1"
      DEMO_RESET_MINUTES: "60"
      CF_MOCK: "1" # no Cloudflare account: domains are simulated
      LOCAL_LOGIN: "true" # no identity provider needed; password sign-in is disabled by demo mode anyway
    volumes:
      - demo-data:/data # NOT the volume of a real instance
volumes:
  demo-data:
```

Put it behind your reverse proxy with HTTPS like a normal instance ([Installation](installation.md)). Recommended:

- `CF_MOCK=1` and no `CF_API_TOKEN`, no `SMTP_RELAY_URL`, no `PROBE_SMTP_URL`, no `BACKUP_S3_*`: the demo has no way to
  reach real mail systems.
- Do not route a real domain to it: mail is only simulated. Visitors can still use the API with their session.
- Keep the default rate limits (`RATE_LIMIT_PER_MINUTE`); the reset also clears what visitors created.
- Outside Docker, `DEMO_MAIL_DIR` defaults to `./tests/fixtures` (run from the repository root); the image ships the
  same files in `/app/demo-mail`.

Locally:

```bash
pnpm build
DEMO_MODE=1 CF_MOCK=1 LOCAL_LOGIN=true DATA_DIR=./demo-data pnpm start
```
