import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Deps } from "../context.js";
import { addresses, auditLog, categories, domains, siteRejections, systemState, users } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { createAddress } from "./addresses.js";
import { ingestMessage } from "./ingest/index.js";

export const DEMO_EMAIL = "demo@example.test";
export const DEMO_DOMAIN = "mail.example.test";
const DEMO_DOMAIN_2 = "alias.example.test";
const STATE_KEY = "demo";

/** The same sites, categories and mails as the documentation screenshots (tests/screenshots/readme.spec.ts). */
export const DEMO_SITES = [
  {
    name: "Discord",
    url: "discord.com",
    local: "quiet-heron-2210",
    mail: "discord-verify-email.eml",
    from: "noreply@discord.com",
    category: "Social",
  },
  {
    name: "Steam",
    url: "store.steampowered.com",
    local: "brave-falcon-7742",
    mail: "steam-guard.eml",
    from: "noreply@steampowered.com",
    category: "Games",
  },
  {
    name: "PayPal",
    url: "paypal.com",
    local: "calm-badger-1187",
    mail: "paypal-code.eml",
    from: "service@paypal.fr",
    category: "Shopping",
  },
  {
    name: "Amazon",
    url: "amazon.com",
    local: "amber-lynx-5307",
    mail: "amazon-otp.eml",
    from: "account-update@amazon.com",
    category: "Shopping",
  },
  {
    name: "Microsoft",
    url: "microsoft.com",
    local: "misty-crane-6034",
    mail: "microsoft-security-code.eml",
    from: "account-security-noreply@accountprotection.microsoft.com",
    category: "Dev",
  },
  {
    name: "GitHub",
    url: "github.com",
    local: "silver-otter-4821",
    mail: "github-device-verification.eml",
    from: "noreply@github.com",
    category: "Dev",
  },
] as const;

const COLORS: Record<string, "blue" | "violet" | "amber" | "green"> = { Social: "blue", Games: "violet", Shopping: "amber", Dev: "green" };

/** Empties the instance (every user, domain and their data) and seeds the demo account. */
export async function resetDemo(d: Deps): Promise<void> {
  const log = d.logger.child({ component: "demo" });
  d.db.transaction((tx) => {
    // Cascades remove sessions, addresses, messages, categories, destinations, keys, rejections…
    tx.delete(users).run();
    tx.delete(domains).run();
    tx.delete(auditLog).run();
  });
  const now = d.now();
  const userId = newId("usr");
  d.db.insert(users).values({ id: userId, email: DEMO_EMAIL, name: "Demo", role: "admin", createdAt: now, lastLoginAt: now }).run();
  const user = d.db.select().from(users).where(eq(users.id, userId)).get()!;
  for (const name of [DEMO_DOMAIN, DEMO_DOMAIN_2]) {
    d.db
      .insert(domains)
      .values({
        id: newId("dom"),
        name,
        transport: "cloudflare",
        status: "active",
        statusDetail: "Demo domain: mail is simulated.",
        createdBy: userId,
        createdAt: now,
        lastCheckedAt: now,
      })
      .run();
  }
  const catIds = new Map<string, string>();
  [...new Set(DEMO_SITES.map((s) => s.category))].forEach((name, position) => {
    const id = newId("cat");
    d.db
      .insert(categories)
      .values({ id, userId, name, color: COLORS[name] ?? "zinc", position, createdAt: now })
      .run();
    catIds.set(name, id);
  });
  for (const s of DEMO_SITES) {
    const { a } = createAddress(d, user, {
      domain: DEMO_DOMAIN,
      site_name: s.name,
      site_url: `https://${s.url}`,
      local_part: s.local,
      category_id: catIds.get(s.category)!,
    });
    const file = path.resolve(d.config.DEMO_MAIL_DIR, s.mail);
    if (!fs.existsSync(file)) {
      log.warn("demo mail missing", { file });
      continue;
    }
    await ingestMessage(d, { raw: fs.readFileSync(file), envelopeFrom: s.from, envelopeTo: `${a.localPart}@${DEMO_DOMAIN}` });
  }
  d.db.update(addresses).set({ pinned: true }).where(eq(addresses.localPart, "silver-otter-4821")).run();
  // A site that rejected the first domain, and a sign-up that is still waiting for its code.
  const rejected = createAddress(d, user, { domain: DEMO_DOMAIN, site_name: "Ticket Shop", site_url: "https://tickets.example.com" }).a;
  d.db
    .update(addresses)
    .set({ status: "paused", label: "rejected by the site", createdAt: now - 2 * 3600_000 })
    .where(eq(addresses.id, rejected.id))
    .run();
  d.db
    .insert(siteRejections)
    .values({ id: newId("rej"), userId, site: "tickets.example.com", domainId: rejected.domainId, addressId: rejected.id, createdAt: now })
    .run();
  createAddress(d, user, { domain: DEMO_DOMAIN_2, site_name: "Ticket Shop", site_url: "https://tickets.example.com" });
  const waiting = createAddress(d, user, { domain: DEMO_DOMAIN, site_name: "Forum", site_url: "https://forum.example.org" }).a;
  d.db
    .update(addresses)
    .set({ createdAt: now - 40 * 60_000 })
    .where(eq(addresses.id, waiting.id))
    .run();
  d.db
    .insert(systemState)
    .values({ key: STATE_KEY, valueJson: JSON.stringify({ reset_at: now }), updatedAt: now })
    .onConflictDoUpdate({ target: systemState.key, set: { valueJson: JSON.stringify({ reset_at: now }), updatedAt: now } })
    .run();
  log.info("demo data reset");
}

/** Time of the last reset (null before the first one). */
export function demoResetAt(d: Deps): number | null {
  const row = d.db.select({ v: systemState.valueJson }).from(systemState).where(eq(systemState.key, STATE_KEY)).get();
  return row ? ((JSON.parse(row.v) as { reset_at: number }).reset_at ?? null) : null;
}

export function demoUser(d: Deps) {
  return d.db
    .select()
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .orderBy(sql`rowid`)
    .get();
}

/**
 * Writes refused in demo mode: anything that would change the instance for other visitors or send something out
 * (domains, destinations, users and invites, API keys, notifications, passwords and two-factor, backups, probes,
 * one-click unsubscribe, mail rules). Addresses, categories and mail stay editable; they come back at the next reset.
 */
const DEMO_BLOCKED = [
  /^\/v1\/domains(\/|$)/,
  /^\/v1\/destinations(\/|$)/,
  /^\/v1\/admin\//,
  /^\/v1\/notify-targets(\/|$)/,
  /^\/v1\/keys(\/|$)/,
  /^\/v1\/auth\/(2fa|password|setup|invite|login)/,
  /^\/v1\/messages\/[^/]+\/unsubscribe$/,
  /^\/v1\/directories(\/|$)/,
  /^\/v1\/rules(\/|$)/,
];

export function demoBlocks(method: string, p: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return DEMO_BLOCKED.some((re) => re.test(p));
}
