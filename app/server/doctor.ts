// `pnpm doctor` (or `node dist/doctor.js` in the Docker image): the admin "Setup check" from the command line.
// Reads the same configuration as the server, prints every check and exits with 1 when one is an error.
//   --json   machine-readable output
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildDeps } from "./build-deps.js";
import { runDiagnostics, type CheckStatus } from "./services/diagnostics.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file */
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}

const deps = buildDeps(config, createLogger("error", { service: "throwaway-mail-doctor" }));
const report = await runDiagnostics(deps);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const tty = process.stdout.isTTY;
  const color = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const mark: Record<CheckStatus, string> = { ok: color(32, "✓"), warn: color(33, "!"), error: color(31, "✗") };
  let group = "";
  for (const c of report.checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`\n${color(1, group.toUpperCase())}`);
    }
    console.log(`${mark[c.status]} ${c.title}: ${c.detail}`);
    if (c.hint && c.status !== "ok") console.log(`    → ${c.hint}`);
  }
  const { ok, warn, error } = report.summary;
  console.log(`\n${ok} ok, ${warn} warning(s), ${error} error(s)`);
}
process.exit(report.summary.error ? 1 : 0);
