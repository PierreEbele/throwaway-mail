# Import from SimpleLogin and addy.io

Moving from a hosted alias service: export your aliases there, upload the file under **Account → Import from
SimpleLogin or addy.io**, check the preview, then import. The same is available from the API
(`POST /v1/import/aliases`).

Importing creates addresses here; it does not move mail. An imported alias receives mail in Throwaway Mail only when
its domain points here:

- **Your own domain** (e.g. `mine.example`), used at SimpleLogin or addy.io: add it to Throwaway Mail, point its MX /
  Email Routing here, and import with _Keep each alias's domain_ and _Keep the alias's local part_. Every alias keeps
  working with the same address.
- **The service's shared domains** (`simplelogin.com`, `aleeas.com`, `anonaddy.me`…): they cannot move. Import onto one
  of your domains (keeping the local part, or a random one), then change the e-mail address on each site over time.
  Keep the old service until you are done.

## Options

| Option                         | Effect                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `domain`                       | Domain of the new addresses. Omitted: each alias keeps its own domain, which must be active here.         |
| `local_part`: `keep`, `random` | Keep the alias's local part (skipped when not allowed here or already taken), or generate a readable one. |
| `category`                     | Category for every imported address (created if missing). Omitted: the file's category, or auto-matched.  |
| `include_disabled`             | Default true: disabled aliases are imported as paused addresses.                                          |
| `dry_run`                      | Default true: only returns the plan. Send `false` to create the addresses.                                |

The response is the report: `format`, `total`, `created`, `skipped`, and one row per alias with the new address, the
site name, and the reason when it is skipped. The site name is the alias's note / description, or its local part.

## Formats and assumptions

Columns are matched by header name, case-insensitively; unknown columns are ignored and their order does not matter.
The format is detected from the headers. Facts checked in November 2026 against the sources linked below.

**SimpleLogin** (Settings → Export aliases, `aliases.csv`): `alias,note,enabled,mailboxes`. `enabled` is `True` or
`False`; `mailboxes` is ignored (forwarding is set up here with destinations). Deleted aliases are not in the export.
Source: [`alias_export_csv` in simple-login/app](https://github.com/simple-login/app/blob/master/app/alias_utils.py).

**addy.io** (Settings → Account data → Export aliases): one column per attribute of the alias model, so there is no
fixed list. Used: `email` (or `local_part` + `domain`), `description`, `active` (`1`/`0` or `true`/`false`) and
`deleted_at` (deleted aliases are included in the export and skipped here). The exact column order and the value
format of booleans and dates are not documented; the importer accepts the usual variants. Sources:
[help page](https://addy.io/help/importing-and-exporting-account-data/),
[`AliasesExport`](https://github.com/anonaddy/anonaddy/blob/master/app/Exports/AliasesExport.php),
[`Alias` model](https://github.com/anonaddy/anonaddy/blob/master/app/Models/Alias.php).

**JSON**: an array of alias objects, or `{ "aliases": [...] }` / `{ "data": [...] }` (the shape of the addy.io API),
with the field names above.

## Export

**Account → Export CSV** (`GET /v1/export/aliases.csv`) writes
`alias,note,enabled,site_name,site_url,category,created_at`. The first three columns follow SimpleLogin's layout, so
tools reading that format understand it; the file imports back here unchanged. Cells starting with `=`, `+`, `-` or
`@` are prefixed with `'` so spreadsheets do not run them as formulas. The full JSON backup
(`GET /v1/export`) remains the way to move between two Throwaway Mail instances.
