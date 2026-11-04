import { eq } from "drizzle-orm";
import type { ApiRouter } from "../lib/http.js";
import { users } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { AddressSettings, addressSettings, examples, templateProblem } from "../services/alias-format.js";

function validate(s: AddressSettings) {
  if (s.format === "template") {
    const problem = templateProblem(s.template);
    if (problem) throw badRequest(`template: ${problem}`);
  }
}

/** Per-user settings for new addresses. */
export function registerSettings(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/settings/addresses",
      summary: "New-address settings: local-part format, default expiry and default max mails",
      tags: ["settings"],
      auth: "user",
    },
    (c) => {
      const s = addressSettings(c.get("user")!);
      return c.json({ settings: s, examples: examples(s) });
    },
  );

  r.add(
    {
      method: "put",
      path: "/v1/settings/addresses",
      summary: "Change the new-address settings",
      description:
        "format: `words` (amber-otter-4821), `random` (`length` characters), `word.word`, or `template` with {word}, {randN}, {digitsN} and {site}, e.g. `{word}-{rand6}`. The defaults apply to addresses created without `expires_at`/`expires_in_days` or `max_messages` (web UI, API, SDK, extension, Bitwarden); null = none.",
      tags: ["settings"],
      auth: "user",
      body: AddressSettings,
    },
    (c, { body }) => {
      validate(body);
      const d = c.get("deps");
      d.db
        .update(users)
        .set({ addressSettingsJson: JSON.stringify(body) })
        .where(eq(users.id, c.get("user")!.id))
        .run();
      return c.json({ settings: body, examples: examples(body) });
    },
  );

  r.add(
    {
      method: "post",
      path: "/v1/settings/addresses/preview",
      summary: "Example local parts for unsaved settings",
      tags: ["settings"],
      auth: "user",
      body: AddressSettings,
    },
    (c, { body }) => {
      validate(body);
      return c.json({ examples: examples(body) });
    },
  );
}
