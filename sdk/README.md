# @throwaway-mail/sdk

Typed client for the Throwaway Mail API. No dependencies; Node.js 18+ (uses the built-in `fetch`), ESM only.

```bash
npm install @throwaway-mail/sdk
```

## Example

[`examples/signup.test.ts`](examples/signup.test.ts) is a complete end-to-end test: create an address, sign up,
wait for the code, clean up.

## Setup

```ts
import { ThrowawayMail, ThrowawayMailError } from "@throwaway-mail/sdk";

const tm = new ThrowawayMail({
  baseUrl: "https://mail-app.example.com",
  apiKey: process.env.TM_API_KEY!, // tm_…, created under "API keys"
  timeoutMs: 30_000, // optional, per request
  // fetch: customFetch,           // optional
});
```

Parameters are camelCase and are sent as the API's snake_case. Returned objects are the API's JSON, unchanged
(snake_case fields, timestamps in epoch milliseconds). Every method accepts a final `{ signal, timeoutMs }` argument.

## Addresses

```ts
// Create an address straight into a category (created if it does not exist yet).
const addr = await tm.addresses.create({ site: "github.com", category: "Dev", createCategory: true });
console.log(addr.email);

// Other options: siteName, siteUrl, domain, localPart, label, forward, destinationId, categoryId, expiresInDays.
await tm.addresses.update(addr.id, { pinned: true, label: "work account" });

// Filters: q, site, domain, status, category (id or "none"), pinned, unread, hasCode, sinceHours, leak, limit, offset.
const recent = await tm.addresses.list({ hasCode: true, sinceHours: 24 });

await tm.addresses.move([addr.id], null); // bulk move to "uncategorised"; also addresses.bulk(ids, "archive" | "pin" | ...)
await tm.addresses.extend(addr.id, 30);
await tm.addresses.delete(addr.id);
```

## Waiting for a verification code

```ts
const since = Date.now();
// ... trigger the sign-up that sends the mail ...
const { code, links, message_id } = await tm.addresses.waitForCode(addr.id, { since, timeoutMs: 120_000 });
```

`waitForCode` repeats the server's long-poll (`GET /v1/addresses/:id/code?wait=…`) until a code arrives or `timeoutMs`
elapses. `since` accepts epoch ms, a `Date`, an ISO string or a message id. `require: "code"` ignores mails that only
contain a link. `addresses.getCode(id, { wait })` makes a single call and returns `null` when nothing arrived.

## Messages

```ts
const inbox = await tm.addresses.messages(addr.id, { limit: 20 });
const msg = await tm.messages.get(inbox[0]!.id); // text, html, headers, extracted codes and links
await tm.messages.markRead(msg.id);
await tm.messages.bulk(addr.id, "archive", { scope: "read" });
```

## Live events

```ts
const ctl = new AbortController();
for await (const event of tm.events({ signal: ctl.signal })) {
  if (event.type === "message.received" && event.has_code) {
    console.log("code for", event.address_id);
  }
}
```

The iterator ends when the stream closes or the signal aborts; it does not reconnect.

## Errors

Non-2xx responses throw `ThrowawayMailError` with `status`, `code` (`not_found`, `bad_request`, ...), `message`,
`details` (validation issues) and `retryAfter` (seconds, on 429). Network failures, timeouts and aborts use status `0`
and code `network_error`, `timeout` or `aborted`.

```ts
try {
  await tm.addresses.create({ siteName: "Shop", category: "Unknown" });
} catch (err) {
  if (err instanceof ThrowawayMailError && err.status === 400) console.error(err.code, err.message, err.details);
  else throw err;
}
```

## Other resources

| Namespace       | Methods                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `categories`    | `list`, `create`, `update`, `delete`, `reorder`                                                                          |
| `smartFolders`  | `list`, `create`, `delete`                                                                                               |
| `directories`   | `list`, `create`, `delete`                                                                                               |
| `destinations`  | `list`, `create`, `update` (PGP key), `refresh`, `resendVerification`, `delete`                                          |
| `notifications` | `list`, `create`, `update`, `delete`, `test`                                                                             |
| `addresses`     | also `get`, `replace`, `senders`, `setFeed`, `stats`                                                                     |
| `account`       | `digest`, `leaks`, `blockLeak`, `staleAddresses`, `cleanupStale`, `panic`, `export`, `import`, `keys.list/create/revoke` |

## Build

```bash
npm run build   # tsc -> dist/
```

## License

MIT
