import crypto from "node:crypto";
import { z } from "zod";
import type { User } from "../db/schema.js";
import { LOCAL_PART_RE } from "../lib/email.js";
import { WORDS, readableLocalPart } from "../lib/words.js";

/**
 * Per-user settings for new addresses: how random local parts look, and the expiry / mail quota applied when the
 * creator (web UI, API, SDK, extension, Bitwarden) does not say.
 */
export const ALIAS_FORMATS = ["words", "random", "word.word", "template"] as const;
export type AliasFormat = (typeof ALIAS_FORMATS)[number];

export const RANDOM_MIN = 6;
export const RANDOM_MAX = 32;
const TOKEN_RE = /\{(word|site|rand(\d{1,2})|digits(\d{1,2}))\}/g;

export const AddressSettings = z.object({
  format: z.enum(ALIAS_FORMATS).default("words"),
  /** Length of "random" local parts. */
  length: z.number().int().min(RANDOM_MIN).max(RANDOM_MAX).default(12),
  /** "template" format, e.g. "{word}-{rand6}". */
  template: z.string().trim().max(64).nullable().default(null),
  default_expires_in_days: z.number().int().min(1).max(3650).nullable().default(null),
  default_max_messages: z.number().int().min(1).max(100_000).nullable().default(null),
});
export type AddressSettings = z.infer<typeof AddressSettings>;

export function addressSettings(user: Pick<User, "addressSettingsJson">): AddressSettings {
  try {
    const r = AddressSettings.safeParse(user.addressSettingsJson ? JSON.parse(user.addressSettingsJson) : {});
    if (r.success) return r.data;
  } catch {
    // fall through to the defaults
  }
  return AddressSettings.parse({});
}

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomChars = (n: number, alphabet = ALNUM) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
const word = () => WORDS[crypto.randomInt(WORDS.length)]!;
/** Site name reduced to local-part characters ("Hacker News" -> "hackernews"), at most 20. */
export const siteSlug = (site: string) =>
  site
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20) || "site";

/** Random bits a template adds (rough): words ~7.5 bits, a random character ~5.2, a digit ~3.3. */
function templateEntropy(template: string): number {
  let bits = 0;
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m[1] === "word") bits += 7.5;
    else if (m[2]) bits += Number(m[2]) * 5.2;
    else if (m[3]) bits += Number(m[3]) * 3.3;
  }
  return bits;
}

function renderTemplate(template: string, site: string): string {
  return template
    .replace(TOKEN_RE, (_all, kind: string, rand?: string, digits?: string) => {
      if (kind === "word") return word();
      if (kind === "site") return siteSlug(site);
      if (rand) return randomChars(Number(rand));
      return randomChars(Number(digits), "0123456789");
    })
    .toLowerCase();
}

/** Why a template cannot be used (null: fine). */
export function templateProblem(template: string | null | undefined): string | null {
  if (!template) return "The template is empty";
  const sizes = [...template.matchAll(TOKEN_RE)].map((m) => Number(m[2] ?? m[3] ?? 1));
  if (sizes.some((n) => n < 1 || n > 32)) return "{randN} and {digitsN} take 1 to 32 characters";
  const literal = template.replace(TOKEN_RE, "");
  if (/[{}]/.test(literal)) return "Unknown placeholder: use {word}, {randN}, {digitsN} or {site}";
  if (templateEntropy(template) < 20)
    return "Not random enough: add {word}, {rand6} or {digits4} so new addresses do not collide (at least 20 bits)";
  for (let i = 0; i < 5; i++) {
    const sample = renderTemplate(template, "Example Site");
    if (!LOCAL_PART_RE.test(sample))
      return `It gives "${sample}": use a-z, 0-9, '.', '_' and '-', start and end with a letter or digit, 64 characters at most`;
  }
  return null;
}

/**
 * A new random local part in the user's format. `attempt` grows after each collision: the short "word.word" format
 * then gets digits appended so a busy domain still finds a free address.
 */
export function generateLocalPart(s: AddressSettings, site: string, attempt = 0): string {
  switch (s.format) {
    case "random":
      return randomChars(1, "abcdefghijklmnopqrstuvwxyz") + randomChars(s.length - 1);
    case "word.word": {
      const base = `${word()}.${word()}`;
      return attempt < 4 ? base : `${base}${randomChars(Math.min(attempt - 2, 6), "0123456789")}`;
    }
    case "template":
      if (s.template && !templateProblem(s.template)) return renderTemplate(s.template, site);
      return readableLocalPart();
    default:
      return readableLocalPart();
  }
}

export function examples(s: AddressSettings, site = "Example"): string[] {
  return Array.from({ length: 3 }, () => generateLocalPart(s, site));
}
