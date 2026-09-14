/** Dev tool: print what the parser extracts from one or more .eml files.  Usage: pnpm tsx scripts/parse-eml.ts file.eml [--debug] */
import fs from "node:fs";
import PostalMime from "postal-mime";
import { parseMessage, htmlToText } from "../app/server/parser/index.js";

async function main() {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  for (const f of args.filter((a) => !a.startsWith("--"))) {
    const e = await PostalMime.parse(fs.readFileSync(f));
    console.log(`== ${f}\nsubject: ${e.subject}`);
    if (debug && e.html) console.log("html->text:", JSON.stringify(htmlToText(e.html)));
    console.log(JSON.stringify(parseMessage({ subject: e.subject, text: e.text, html: e.html }), null, 2));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
