/**
 * Send a .eml file to /ingest, signed exactly like the Cloudflare Email Worker does.
 *
 *   pnpm simulate --to silver-otter-4821@mail.example.test tests/fixtures/github-device-verification.eml
 *
 * Options: --to <rcpt> (required) --from <sender> --url <app url> --secret <INGEST_SECRET>
 * Defaults come from the environment / .env (APP_URL or http://localhost:3000, INGEST_SECRET).
 */
import fs from "node:fs";
import { ingestSignature, INGEST_HEADERS } from "../app/server/routes/ingest.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    /* no .env */
  }
  const to = arg("to");
  const file = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"))
    .pop();
  if (!to || !file) {
    console.error("usage: pnpm simulate --to <address> [--from sender@x] [--url http://localhost:3000] [--secret ...] <file.eml>");
    process.exit(2);
  }
  const from = arg("from") ?? "sender@example.com";
  const url = (arg("url") ?? process.env.SIMULATE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
  const secret = arg("secret") ?? process.env.INGEST_SECRET ?? "dev-ingest-secret-change-me";
  const body = fs.readFileSync(file);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${url}/ingest`, {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      [INGEST_HEADERS.timestamp]: ts,
      [INGEST_HEADERS.signature]: ingestSignature(secret, ts, from, to, body),
      [INGEST_HEADERS.from]: from,
      [INGEST_HEADERS.to]: to,
    },
    body: new Uint8Array(body),
  });
  const text = await res.text();
  console.log(`${res.status} ${text}`);
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
