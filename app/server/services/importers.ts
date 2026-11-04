import { and, eq } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, domains, type User } from "../db/schema.js";
import { csvObjects } from "../lib/csv.js";
import { LOCAL_PART_RE } from "../lib/email.js";
import { badRequest } from "../lib/errors.js";
import { categoryByName } from "./categories.js";
import { createAddress } from "./addresses.js";

/**
 * Import of aliases exported by other alias services. Formats (see docs/import.md for the sources and assumptions):
 * - SimpleLogin CSV (Settings → Export aliases): alias,note,enabled,mailboxes
 * - addy.io CSV (Settings → Account data → Export aliases): every column of the alias model, among which
 *   email, local_part, domain, description, active, created_at, deleted_at
 * - Throwaway Mail CSV (GET /v1/export/aliases.csv): alias,note,enabled,site_name,site_url,category,created_at
 * - JSON: an array of objects, or { aliases | data: [...] }, with the same field names as the CSV formats.
 */
export type ImportFormat = "simplelogin" | "addy" | "throwaway";

export interface SourceAlias {
  email: string;
  note: string | null;
  enabled: boolean;
  deleted: boolean;
  site_name: string | null;
  site_url: string | null;
  category: string | null;
}

const truthy = (v: unknown) => v === true || v === 1 || (typeof v === "string" && /^(true|1|yes|y|on)$/i.test(v.trim()));

function detect(keys: string[]): ImportFormat {
  if (keys.includes("site_name")) return "throwaway";
  if (keys.includes("alias")) return "simplelogin";
  if (keys.includes("email") && (keys.includes("local_part") || keys.includes("active") || keys.includes("aliasable_id"))) return "addy";
  throw badRequest(
    "Unrecognised file: expected a SimpleLogin export (alias,note,enabled,mailboxes), an addy.io export (email,local_part,…,active) or a Throwaway Mail CSV",
  );
}

export function parseAliasFile(content: string, format: ImportFormat | "auto" = "auto"): { format: ImportFormat; aliases: SourceAlias[] } {
  let rows: Array<Record<string, unknown>>;
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw badRequest("Invalid JSON file");
    }
    const list = Array.isArray(json)
      ? json
      : ((json as { aliases?: unknown; data?: unknown }).aliases ?? (json as { data?: unknown }).data);
    if (!Array.isArray(list)) throw badRequest("JSON file: expected an array of aliases, or { aliases: [...] } / { data: [...] }");
    rows = list.map((x) => Object.fromEntries(Object.entries((x ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v])));
  } else rows = csvObjects(content);
  if (!rows.length) return { format: format === "auto" ? "simplelogin" : format, aliases: [] };
  const fmt = format === "auto" ? detect(Object.keys(rows[0]!)) : format;
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
  const aliases = rows
    .map((r): SourceAlias => {
      const email = str(r.alias ?? r.email).toLowerCase();
      const note = str(r.note ?? r.description) || null;
      if (fmt === "addy")
        return {
          email,
          note,
          enabled: truthy(r.active),
          deleted: !!str(r.deleted_at),
          site_name: null,
          site_url: null,
          category: null,
        };
      return {
        email,
        note,
        enabled: r.enabled === undefined || str(r.enabled) === "" ? true : truthy(r.enabled),
        deleted: false,
        site_name: str(r.site_name) || null,
        site_url: str(r.site_url) || null,
        category: str(r.category) || null,
      };
    })
    .filter((a) => a.email);
  return { format: fmt, aliases };
}

export interface ImportOptions {
  /** Domain of the new addresses (name or id); omitted: keep each alias's own domain, which must be a domain of this instance. */
  domain?: string;
  /** "keep" the source local part (skipped when invalid or taken) or give each address a "random" one. */
  local_part: "keep" | "random";
  /** Category for every imported address (created when missing); otherwise the file's category, or auto-matched. */
  category?: string;
  include_disabled: boolean;
  dry_run: boolean;
}

export interface ImportRow {
  source: string;
  email: string | null;
  site_name: string;
  status: "active" | "paused";
  action: "create" | "skip";
  reason?: string;
  id?: string;
}

/** Site name of an imported alias: its note / description, else its local part (SimpleLogin aliases are often site-based). */
function siteNameOf(a: SourceAlias, local: string) {
  const s = a.site_name ?? a.note ?? local.replace(/[._-]?[a-z]*\d{2,}$/, "").replace(/[._]/g, " ");
  return (s.trim() || local).slice(0, 120);
}

export function importAliases(d: Deps, user: User, list: SourceAlias[], opts: ImportOptions) {
  const target = opts.domain
    ? d.db
        .select()
        .from(domains)
        .where(and(eq(domains.status, "active")))
        .all()
        .find((x) => x.name === opts.domain || x.id === opts.domain)
    : null;
  if (opts.domain && !target) throw badRequest(`Unknown or inactive domain ${opts.domain}`);
  const active = new Map(
    d.db
      .select()
      .from(domains)
      .where(eq(domains.status, "active"))
      .all()
      .map((x) => [x.name, x]),
  );
  const planned = new Set<string>();
  const rows: ImportRow[] = [];
  const run = () => {
    const forcedCategory = opts.category && !opts.dry_run ? categoryByName(d, user, opts.category, true) : undefined;
    for (const a of list) {
      const [srcLocal = "", srcDomain = ""] = a.email.split("@");
      const site_name = siteNameOf(a, srcLocal);
      const status = a.enabled ? ("active" as const) : ("paused" as const);
      const row: ImportRow = { source: a.email, email: null, site_name, status, action: "skip" };
      rows.push(row);
      if (!srcLocal || !srcDomain) {
        row.reason = "not an e-mail address";
        continue;
      }
      if (a.deleted) {
        row.reason = "deleted in the source service";
        continue;
      }
      if (!a.enabled && !opts.include_disabled) {
        row.reason = "disabled in the source service";
        continue;
      }
      const domain = target ?? active.get(srcDomain);
      if (!domain) {
        row.reason = `${srcDomain} is not a domain of this instance: choose a target domain`;
        continue;
      }
      let local: string | undefined;
      if (opts.local_part === "keep") {
        if (!LOCAL_PART_RE.test(srcLocal)) {
          row.reason = "local part not allowed here (a-z, 0-9, . _ -)";
          continue;
        }
        const taken =
          planned.has(`${srcLocal}@${domain.name}`) ||
          !!d.db
            .select({ id: addresses.id })
            .from(addresses)
            .where(and(eq(addresses.domainId, domain.id), eq(addresses.localPart, srcLocal)))
            .get();
        if (taken) {
          row.reason = `${srcLocal}@${domain.name} already exists`;
          continue;
        }
        local = srcLocal;
        planned.add(`${srcLocal}@${domain.name}`);
      }
      row.action = "create";
      row.email = local ? `${local}@${domain.name}` : null;
      if (opts.dry_run) continue;
      const category_id =
        forcedCategory !== undefined ? forcedCategory : a.category ? categoryByName(d, user, a.category, true) : undefined;
      const { a: created, domain: dn } = createAddress(d, user, {
        domain: domain.id,
        local_part: local,
        site_name,
        site_url: a.site_url,
        label: a.note && a.note !== site_name ? a.note.slice(0, 120) : `imported from ${srcDomain}`,
        category_id,
      });
      if (status === "paused") d.db.update(addresses).set({ status }).where(eq(addresses.id, created.id)).run();
      row.email = `${created.localPart}@${dn}`;
      row.id = created.id;
    }
  };
  if (opts.dry_run) run();
  else d.db.transaction(() => run());
  const created = rows.filter((r) => r.action === "create").length;
  return { dry_run: opts.dry_run, total: rows.length, created, skipped: rows.length - created, rows };
}
