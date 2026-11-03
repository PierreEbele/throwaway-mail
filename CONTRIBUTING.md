# Contributing

## Setup

```bash
pnpm install
pnpm dev        # API on :3000 (CF_MOCK=1 recommended)
pnpm dev:web    # web UI on :5173, proxied to the API
```

See [docs/development.md](docs/development.md) for the fake identity provider, the mail simulator and the tests.

## Before opening a pull request

```bash
pnpm typecheck
pnpm lint        # strict unused checks + prettier --check
pnpm test
```

- Keep changes focused; one feature or fix per pull request.
- Add or update tests for behaviour changes (integration tests run against the real app with `makeTestApp`).
- Database changes: edit `app/server/db/schema.ts`, then `pnpm db:generate --name <change>` and commit the migration.
- Code comments and UI strings are in English (the extension UI is currently French).
