import fs from "node:fs";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Deps } from "../context.js";
import { metrics } from "../services/metrics.js";
import { z } from "zod";
import type { ApiRouter } from "../lib/http.js";
import { clientIp } from "../lib/http.js";
import { addresses, auditLog, domains, leakEvents, messages, notifyTargets, sessions, users } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { userOut } from "../services/serialize.js";
import { getMailbox } from "../services/mailbox/settings.js";
import { runDiagnostics } from "../services/diagnostics.js";

function dbBytes(deps: Deps) {
  let total = 0;
  for (const f of [deps.config.databasePath, `${deps.config.databasePath}-wal`]) {
    try {
      total += fs.statSync(f).size;
    } catch {
      /* in-memory or missing */
    }
  }
  return total;
}

const count = (deps: Deps, table: SQLiteTable) =>
  deps.db
    .select({ n: sql<number>`count(*)` })
    .from(table)
    .get()!.n;

export function healthSnapshot(deps: Deps) {
  const now = deps.now();
  return {
    uptime_s: Math.round((Date.now() - metrics.startedAt) / 1000),
    db_bytes: dbBytes(deps),
    counts: {
      users: count(deps, users),
      addresses: count(deps, addresses),
      messages: count(deps, messages),
      messages_24h: deps.db
        .select({ n: sql<number>`count(*)` })
        .from(messages)
        .where(sql`${messages.receivedAt} > ${now - 86400_000}`)
        .get()!.n,
      leaks: count(deps, leakEvents),
      notify_targets: count(deps, notifyTargets),
      notify_failing: deps.db
        .select({ n: sql<number>`count(*)` })
        .from(notifyTargets)
        .where(sql`${notifyTargets.lastError} is not null`)
        .get()!.n,
    },
    domains: deps.db
      .select()
      .from(domains)
      .all()
      .map((d) => {
        const mailbox = d.transport === "imap" ? getMailbox(deps, d.id) : null;
        return {
          name: d.name,
          transport: d.transport,
          status: d.status,
          last_poll_at: mailbox?.lastPollAt ?? null,
          last_poll_error: mailbox?.lastPollError ?? null,
          last_ingest_at: d.lastIngestAt,
          last_checked_at: d.lastCheckedAt,
          dns_missing: d.dnsMissingJson ? (JSON.parse(d.dnsMissingJson) as unknown[]).length : 0,
        };
      }),
    ingest: metrics.ingest.entries().map(([l, v]) => ({ ...l, count: v })),
    http: metrics.http.entries().map(([l, v]) => ({ ...l, count: v })),
    jobs: Object.fromEntries(metrics.jobs),
    cloudflare: deps.cf.mode,
    retention_days: deps.config.RETENTION_DAYS,
    metrics_enabled: !!deps.config.METRICS_TOKEN,
  };
}

export function healthGauges(deps: Deps) {
  const h = healthSnapshot(deps);
  return [
    { name: "throwaway_uptime_seconds", help: "Process uptime", value: h.uptime_s },
    { name: "throwaway_db_bytes", help: "SQLite database size (with WAL)", value: h.db_bytes },
    ...Object.entries(h.counts).map(([k, v]) => ({ name: "throwaway_rows", help: "Row counts", value: v, labels: { kind: k } })),
    ...h.domains.map((d) => ({
      name: "throwaway_domain_last_ingest_timestamp_seconds",
      help: "Last mail received per domain",
      value: Math.round((d.last_ingest_at ?? 0) / 1000),
      labels: { domain: d.name },
    })),
  ];
}

const activeAdmins = (d: Deps) =>
  d.db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.disabled, false)))
    .get()!.n;

export function registerAdmin(r: ApiRouter) {
  r.add(
    {
      method: "get",
      path: "/v1/admin/health",
      summary: "Instance health: database, domains, jobs, ingest counters",
      tags: ["admin"],
      auth: "admin",
    },
    (c) => c.json(healthSnapshot(c.get("deps"))),
  );

  r.add(
    {
      method: "get",
      path: "/v1/admin/diagnostics",
      summary: "Setup check: configuration, sign-in, Cloudflare, domains and backups, each ok/warn/error with a hint",
      tags: ["admin"],
      auth: "admin",
    },
    async (c) => c.json(await runDiagnostics(c.get("deps"))),
  );

  r.add({ method: "get", path: "/v1/admin/users", summary: "List users", tags: ["admin"], auth: "admin" }, (c) => {
    const rows = c.get("deps").db.select().from(users).orderBy(users.createdAt).all();
    return c.json({ users: rows.map(userOut) });
  });

  r.add(
    {
      method: "patch",
      path: "/v1/admin/users/:id",
      summary: "Disable or re-enable a user, or change the role of a local account (SSO roles come from IdP groups)",
      tags: ["admin"],
      auth: "admin",
      body: z.object({ disabled: z.boolean().optional(), role: z.enum(["admin", "user"]).optional() }),
    },
    (c, { body }) => {
      const d = c.get("deps");
      const me = c.get("user")!;
      const id = c.req.param("id")!;
      const ip = clientIp(c);
      const target = d.db.select().from(users).where(eq(users.id, id)).get();
      if (!target) throw notFound("User");
      if (body.disabled !== undefined) {
        if (id === me.id && body.disabled) throw badRequest("You cannot disable yourself");
        d.db.update(users).set({ disabled: body.disabled }).where(eq(users.id, id)).run();
        if (body.disabled) d.db.delete(sessions).where(eq(sessions.userId, id)).run();
        audit(d, me.id, body.disabled ? "user.disabled" : "user.enabled", id, undefined, ip);
      }
      if (body.role && body.role !== target.role) {
        if (target.oidcSub !== null) throw badRequest("This user's role comes from the identity provider's groups");
        if (body.role === "user" && activeAdmins(d) <= 1) throw badRequest("The last admin cannot be demoted");
        d.db.update(users).set({ role: body.role }).where(eq(users.id, id)).run();
        audit(d, me.id, "user.role_changed", id, { from: target.role, to: body.role }, ip);
      }
      return c.json({ user: userOut(d.db.select().from(users).where(eq(users.id, id)).get()!) });
    },
  );

  r.add(
    {
      method: "get",
      path: "/v1/admin/audit",
      summary: "Audit log",
      tags: ["admin"],
      auth: "admin",
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
    },
    (c, { query }) => {
      const rows = c.get("deps").db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(query.limit).all();
      return c.json({
        entries: rows.map((e) => ({
          id: e.id,
          user_id: e.userId,
          action: e.action,
          target: e.target,
          meta: e.metaJson ? JSON.parse(e.metaJson) : null,
          ip: e.ip,
          created_at: e.createdAt,
        })),
      });
    },
  );
}
