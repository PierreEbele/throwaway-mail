# Development

Node 22+ and pnpm.

## Quick local try-out

Runs everything locally with a mocked Cloudflare and a fake OpenID provider that signs you in as an admin without a password. Domains turn active instantly, and destinations become verified when you press **Check status**.

```bash
pnpm install && pnpm build
pnpm fake-oidc &                       # fake IdP on http://127.0.0.1:3298 (user "admin", group admins)
CF_MOCK=1 OIDC_ISSUER=http://127.0.0.1:3298 OIDC_CLIENT_SECRET=dev-oidc-secret OIDC_ALLOW_INSECURE=1 pnpm start
```

Open http://localhost:3000, press **Sign in**, add a domain (any name), create an address and send it a test mail:

```bash
pnpm simulate --to <address> tests/fixtures/github-device-verification.eml
```

To act as a non-admin, open `http://127.0.0.1:3298/_as?user=alice` before signing in. The fake provider is for development only.

## Day-to-day

```bash
pnpm install
cp .env.example .env       # set CF_MOCK=1 for local work
pnpm fake-oidc &           # fake SSO provider (set OIDC_ISSUER=http://127.0.0.1:3298, OIDC_CLIENT_SECRET=dev-oidc-secret, OIDC_ALLOW_INSECURE=1)
pnpm dev                   # API on :3000 (tsx watch)
pnpm dev:web               # UI on :5173, proxies /v1 to :3000
pnpm simulate --to <address> tests/fixtures/google-verification-code.eml
pnpm tsx scripts/parse-eml.ts some.eml --debug   # see what the parser extracts
```

Tests:

```bash
pnpm test                  # unit + integration (Vitest): parser fixtures, ingest, API, isolation, worker, Cloudflare client
pnpm build && pnpm exec playwright install chromium && pnpm test:e2e   # UI smoke test
pnpm screenshots   # regenerate the README screenshots in docs/images
pnpm typecheck
```

`pnpm lint` runs the strict unused-code checks and `prettier --check`; `pnpm format` fixes formatting.

Database migrations live in `app/server/db/migrations` and run at startup. After changing `schema.ts`, run
`pnpm db:generate --name <change>` and commit the generated migration.

Adding a parser fixture: drop an `.eml` in `tests/fixtures` and add its expected code or link to `expected.json`.

See also [architecture.md](architecture.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
