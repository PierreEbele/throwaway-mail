# Security policy

Throwaway Mail stores other people's mail, so security reports are welcome and handled first.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting
(_Security → Report a vulnerability_ on the repository). You should get an answer within a week.

Useful details: affected version or commit, a description of the impact, and steps to reproduce.

## Scope

In scope: the app (`app/`), the Email Worker (`worker/`), the browser extension (`extension/`) and the SDK (`sdk/`).
Out of scope: issues that need an already compromised admin account or host, and missing hardening of your own
reverse proxy or identity provider.

## Hardening notes

- Run the app without network access to sensitive internal services: outbound requests (notifications, webhooks,
  one-click unsubscribe) refuse private addresses after DNS resolution, but DNS can change between check and connect.
- `INGEST_SECRET` authenticates the Worker; keep it long and random.
