# Cloudflare tokens, step by step

Throwaway Mail needs two values from Cloudflare in `.env`, and the Email Worker needs a third token to be deployed.
This page walks through each one with the exact clicks. Cloudflare renames menus from time to time: if a label
differs, look for the closest one.

| What              | Goes in                                  | Needed for                                     |
| ----------------- | ---------------------------------------- | ---------------------------------------------- |
| App API token     | `CF_API_TOKEN` in `.env`                 | the app configures domains and destinations    |
| Account ID        | `CF_ACCOUNT_ID` in `.env`                | destinations and the Worker check              |
| Worker deploy key | your shell only (`CLOUDFLARE_API_TOKEN`) | `wrangler deploy`, when `wrangler login` fails |

## 1. Account ID

1. Open <https://dash.cloudflare.com> and click one of your domains.
2. On the domain's **Overview** page, scroll down: the right column shows **Account ID**. Click to copy it.
3. Put it in `.env`: `CF_ACCOUNT_ID=…` (32 hexadecimal characters, no quotes).

## 2. App API token

Both kinds of token work:

- **User token**: top-right avatar → **My Profile** → **API Tokens** → **Create Token**.
- **Account token**: **Manage Account** → **Account API Tokens** → **Create Token**. Prefer this one if several
  people share the Cloudflare account: it does not stop working when a person leaves.

Then:

1. Choose **Create Custom Token** → **Get started**.
2. Name it, for example `throwaway-mail`.
3. Add these permissions, one row each (**+ Add more**):

   | First list | Second list             | Third list |
   | ---------- | ----------------------- | ---------- |
   | Zone       | Zone                    | Read       |
   | Zone       | Zone Settings           | Read       |
   | Zone       | Email Routing Rules     | Edit       |
   | Zone       | DNS                     | Read       |
   | Account    | Email Routing Addresses | Edit       |
   | Account    | Workers Scripts         | Read       |

   The last row is optional: it only lets Setup check confirm that the Worker is deployed. Use **Zone Settings:
   Edit** instead of Read if you want the app to turn Email Routing on for new domains by itself.

4. **Zone Resources**: _Include → All zones_, or _Specific zone_ once per mail domain.
5. **Account Resources** (user tokens only): _Include →_ your account.
6. Leave **Client IP Address Filtering** empty unless your server has a fixed IP, and **TTL** empty.
7. **Continue to summary** → **Create Token**. Copy the token now: Cloudflare shows it only once.
8. Put it in `.env`: `CF_API_TOKEN=…`, then restart the app: `docker compose up -d`.

To add a permission later, edit the token (**⋯ → Edit**) and save: the value does not change, nothing to restart.

## 3. Check

Open **Admin → Setup check** in the app (or `pnpm run doctor`). The Cloudflare group should read:

- **Cloudflare API token: Active**
- **Permission: Email Routing Addresses**
- **Email Worker deployed** (after step 4)

## 4. Worker deploy key (only if `wrangler login` fails)

`pnpm exec wrangler login` opens the browser and needs no token. If it fails (_invalid_state_, _No CSRF value_…):

1. **My Profile** → **API Tokens** → **Create Token**, template **Edit Cloudflare Workers** → **Use template**.
2. Account Resources: your account. Zone Resources: _All zones_. **Continue to summary** → **Create Token**.
3. In the `worker/` directory, paste it without leaving it in your shell history:

   ```bash
   read -s CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
   ```

   ```bash
   pnpm exec wrangler deploy -c wrangler.local.toml
   ```

This key is not needed by the app; you can delete it after deploying.

## Troubleshooting

| Setup check says                                 | Fix                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| _Invalid API Token (code 1000)_                  | The value in `.env` is wrong: no quotes, no spaces, the whole token. Check `CF_ACCOUNT_ID` too. |
| _Authentication error (code 10000)_ on an action | A permission row is missing: compare with the table in step 2.                                  |
| _No Worker named "throwaway-mail-ingest"_        | Deploy the Worker, or set `WORKER_NAME` to the `name` in `worker/wrangler.toml`.                |
| _Not checked: the token may not read Workers_    | Optional: add **Account → Workers Scripts → Read** to the token.                                |
| A domain is _not found_                          | The token's Zone Resources do not include that domain, or it is in another Cloudflare account.  |
