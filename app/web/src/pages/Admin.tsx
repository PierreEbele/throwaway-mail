import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../api";
import type { AuditEntry, Domain, Role, User } from "../types";
import { InvitesCard, useCreateInvite } from "./admin/InvitesCard";
import { useAuth } from "../auth";
import { Badge, EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../components/ui";
import { useDomains } from "./Addresses";
import { fullDate, timeAgo } from "../util";

import { AddDomainForm, POLICY_HELP } from "./admin/AddDomainForm";
import { MailboxPanel } from "./admin/MailboxPanel";
import { BackupCard, ProbeCard, type BackupHealth, type ProbeHealth } from "./admin/ReliabilityCards";

export function DomainsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const usersQ = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const setOwner = useMutation({
    mutationFn: ({ id, owner }: { id: string; owner: string }) => patch(`/v1/domains/${id}`, { owner_id: owner }),
    onSuccess: () => {
      inv();
      toast("Owner changed: the domain's To sort box moved with it", "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["domains"] });
  };
  const verify = useMutation({
    mutationFn: (id: string) => post<{ domain: Domain }>(`/v1/domains/${id}/verify`),
    onSuccess: (r) => {
      inv();
      toast(`${r.domain.name}: ${r.domain.status}`, r.domain.status === "active" ? "success" : "info");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const setPolicyM = useMutation({
    mutationFn: ({ id, p }: { id: string; p: string }) => patch(`/v1/domains/${id}`, { unknown_policy: p }),
    onSuccess: inv,
  });
  const setForwardUnknown = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => patch(`/v1/domains/${id}`, { forward_unknown: on }),
    onSuccess: inv,
    onError: (e) => toast((e as Error).message, "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/v1/domains/${id}`),
    onSuccess: inv,
    onError: (e) => toast((e as Error).message, "error"),
  });

  return (
    <>
      <PageHeader
        title="Domains"
        subtitle="Shared by all users. Mail arrives through Cloudflare Email Routing (catch-all rule → Worker) or is polled from an IMAP catch-all mailbox and forwarded over SMTP."
      />
      <AddDomainForm users={usersQ.data} />
      {domains.isLoading && <Spinner />}
      {domains.data?.length === 0 && (
        <EmptyState title="No domains yet">
          Add the first domain above: on Cloudflare, or with any provider offering a catch-all IMAP mailbox.
        </EmptyState>
      )}
      <ul className="space-y-3">
        {domains.data?.map((d) => (
          <li key={d.id} className="card p-4" data-testid={`domain-${d.name}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{d.name}</span>
                <Badge value={d.status} />
                {d.transport === "imap" && <span className="text-xs text-zinc-500">IMAP mailbox</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`own-${d.id}`}>
                  Owner of {d.name}
                </label>
                <select
                  id={`own-${d.id}`}
                  className="input w-auto"
                  value={d.owner?.id ?? ""}
                  onChange={(e) => {
                    const u = usersQ.data?.find((x) => x.id === e.target.value);
                    if (u && confirmAction(`Give ${d.name} to ${u.name ?? u.email}? Its "To sort" box and the mail in it move to them.`))
                      setOwner.mutate({ id: d.id, owner: u.id });
                  }}
                >
                  {!d.owner && <option value="">no owner</option>}
                  {usersQ.data?.map((u) => (
                    <option key={u.id} value={u.id}>
                      owner: {u.name ?? u.email}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor={`pol-${d.id}`}>
                  Unknown address policy for {d.name}
                </label>
                <select
                  id={`pol-${d.id}`}
                  className="input w-auto"
                  value={d.unknown_policy}
                  onChange={(e) => setPolicyM.mutate({ id: d.id, p: e.target.value })}
                >
                  {Object.keys(POLICY_HELP).map((k) => (
                    <option key={k} value={k}>
                      unknown: {k}
                    </option>
                  ))}
                </select>
                {d.transport === "cloudflare" && (
                  <button
                    className="btn-secondary"
                    onClick={() => verify.mutate(d.id)}
                    disabled={verify.isPending && verify.variables === d.id}
                  >
                    Re-check
                  </button>
                )}
                <button
                  className="btn-ghost text-red-600"
                  onClick={() =>
                    confirmAction(
                      `Remove ${d.name}? Only possible when it has no addresses. ${d.transport === "imap" ? "Polling stops; the mailbox is left as it is." : "Cloudflare settings are left untouched."}`,
                    ) && remove.mutate(d.id)
                  }
                >
                  Remove
                </button>
              </div>
            </div>
            {d.previous_catch_all &&
              (() => {
                const oldFwd = d.previous_catch_all.actions.find((a) => a.type === "forward")?.value?.[0];
                return (
                  <div className="mt-2 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
                    <p>
                      Catch-all before the app:{" "}
                      <strong>
                        {d.previous_catch_all.actions.map((a) => `${a.type}${a.value ? " → " + a.value.join(", ") : ""}`).join("; ")}
                      </strong>
                      . It is restored if you remove the domain here.
                    </p>
                    {oldFwd && (
                      <p className="mt-1 flex flex-wrap items-center gap-2">
                        {d.catchall_forward_to ? (
                          <>
                            Unknown addresses are still forwarded to {d.catchall_forward_to} and listed under “To sort”.
                            <button
                              className="btn-ghost"
                              onClick={() =>
                                confirmAction(
                                  `Stop forwarding unknown addresses to ${oldFwd}? The "${d.unknown_policy}" policy will apply instead.`,
                                ) && setForwardUnknown.mutate({ id: d.id, on: false })
                              }
                            >
                              Stop forwarding
                            </button>
                          </>
                        ) : (
                          <>
                            Unknown addresses follow the “{d.unknown_policy}” policy.
                            <button className="btn-ghost" onClick={() => setForwardUnknown.mutate({ id: d.id, on: true })}>
                              Forward them to {oldFwd} again
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                );
              })()}
            {d.status_detail && (
              <p className={`mt-2 text-sm ${d.status === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400"}`}>
                {d.status_detail}
              </p>
            )}
            {!!d.dns_missing?.length && (
              <div className="mt-3 overflow-x-auto">
                <p className="mb-1 text-sm font-medium">Missing DNS records</p>
                <table className="w-full font-mono text-xs">
                  <thead className="text-left text-zinc-500">
                    <tr>
                      <th className="pr-4">Type</th>
                      <th className="pr-4">Name</th>
                      <th className="pr-4">Content</th>
                      <th>Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.dns_missing.map((r, i) => (
                      <tr key={i}>
                        <td className="pr-4">{r.type}</td>
                        <td className="pr-4">{r.name}</td>
                        <td className="pr-4 break-all">{r.content}</td>
                        <td>{r.priority ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.mailbox ? (
              <MailboxPanel domain={{ ...d, mailbox: d.mailbox }} />
            ) : (
              <p className="mt-2 text-xs text-zinc-500">
                Zone {d.cf_zone_id ?? "—"} · last checked {timeAgo(d.last_checked_at)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me, ssoEnabled, ssoProvider, localEnabled } = useAuth();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const updateUser = useMutation({
    mutationFn: ({ id, ...body }: { id: string; disabled?: boolean; role?: Role }) => patch(`/v1/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const reset2fa = useMutation({
    mutationFn: (id: string) => del(`/v1/admin/users/${id}/2fa`),
    onSuccess: () => {
      toast("Two-factor authentication turned off", "success");
      return qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const { create: resetLink, dialog } = useCreateInvite();
  const subtitle = [
    ssoEnabled && `${ssoProvider} accounts are created at their first sign-in and their role follows ${ssoProvider} groups.`,
    localEnabled && "Local accounts join with an invite link; their role is set here.",
    "Each user's addresses, messages, destinations and keys are private.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <PageHeader title="Users" subtitle={subtitle} />
      {localEnabled && <InvitesCard />}
      {users.isLoading && <Spinner />}
      <ErrorText error={users.error ?? resetLink.error} />
      <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
        {users.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate">{u.name ?? u.email}</div>
              <div className="truncate text-xs text-zinc-500">
                {u.email} · {u.auth === "local" ? "local account" : ssoProvider} · last sign-in {timeAgo(u.last_login_at)}
              </div>
            </div>
            {u.auth === "local" ? (
              <select
                className="input w-auto"
                aria-label={`Role of ${u.email}`}
                value={u.role}
                onChange={(e) => updateUser.mutate({ id: u.id, role: e.target.value as Role })}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            ) : (
              <Badge value={u.role} />
            )}
            {u.disabled && <Badge value="disabled" />}
            {u.two_factor && (
              <>
                <Badge value="2FA" />
                <button
                  className="btn-ghost"
                  onClick={() =>
                    confirmAction(`Turn off two-factor authentication for ${u.email}? They can sign in with their password alone.`) &&
                    reset2fa.mutate(u.id)
                  }
                >
                  Reset 2FA
                </button>
              </>
            )}
            {localEnabled && u.auth === "local" && (
              <button
                className="btn-ghost"
                onClick={() =>
                  confirmAction(`Create a password reset link for ${u.email}? Their sessions end when they use it.`) &&
                  resetLink.mutate({ email: u.email, role: u.role })
                }
              >
                Reset password
              </button>
            )}
            {u.id !== me?.id && (
              <button
                className="btn-ghost"
                onClick={() =>
                  (u.disabled || confirmAction(`Disable ${u.email}? They are signed out and their API keys stop working.`)) &&
                  updateUser.mutate({ id: u.id, disabled: !u.disabled })
                }
              >
                {u.disabled ? "Enable" : "Disable"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {dialog}
    </>
  );
}

export function AuditPage() {
  const log = useQuery({
    queryKey: ["audit"],
    queryFn: () => get<{ entries: AuditEntry[] }>("/v1/admin/audit?limit=200").then((r) => r.entries),
  });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Admin and security-relevant actions." />
      {log.isLoading && <Spinner />}
      <ErrorText error={log.error} />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500 uppercase">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Action</th>
              <th className="px-4 py-2">Target</th>
              <th className="px-4 py-2">Details</th>
              <th className="px-4 py-2">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {log.data?.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2 whitespace-nowrap">{fullDate(e.created_at)}</td>
                <td className="px-4 py-2 font-mono">{e.action}</td>
                <td className="px-4 py-2 font-mono text-xs">{e.target}</td>
                <td className="px-4 py-2 font-mono text-xs break-all">{e.meta ? JSON.stringify(e.meta) : ""}</td>
                <td className="px-4 py-2 text-xs">{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface Health {
  uptime_s: number;
  db_bytes: number;
  cloudflare: string;
  retention_days: number;
  metrics_enabled: boolean;
  counts: Record<string, number>;
  domains: Array<{
    name: string;
    transport: "cloudflare" | "imap";
    status: string;
    last_ingest_at: number | null;
    last_checked_at: number | null;
    last_poll_at: number | null;
    last_poll_error: string | null;
    dns_missing: number;
  }>;
  ingest: Array<{ action: string; reason: string; count: number }>;
  jobs: Record<string, { at: number; ok: boolean; detail: string }>;
  backup: BackupHealth;
  probe: ProbeHealth;
}

const bytes = (n: number) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const duration = (s: number) =>
  s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;

export function HealthPage() {
  const q = useQuery({ queryKey: ["admin-health"], queryFn: () => get<Health>("/v1/admin/health"), refetchInterval: 30_000 });
  const h = q.data;
  const stat = (label: string, value: string | number, warn = false) => (
    <div className="card p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{value}</p>
    </div>
  );
  return (
    <>
      <PageHeader title="Health" subtitle="Refreshes every 30 seconds. Counters reset when the app restarts." />
      {q.isLoading && <Spinner />}
      <ErrorText error={q.error} />
      {h && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {stat("Uptime", duration(h.uptime_s))}
            {stat("Database", bytes(h.db_bytes))}
            {stat("Mails (24 h)", h.counts.messages_24h ?? 0)}
            {stat("Failing notification targets", h.counts.notify_failing ?? 0, (h.counts.notify_failing ?? 0) > 0)}
            {stat("Users", h.counts.users ?? 0)}
            {stat("Addresses", h.counts.addresses ?? 0)}
            {stat("Stored mails", h.counts.messages ?? 0)}
            {stat("Leaks recorded", h.counts.leaks ?? 0)}
          </div>
          <section className="card p-5">
            <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Domains</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="py-1">Domain</th>
                  <th>Status</th>
                  <th>Last mail</th>
                  <th>Last check / poll</th>
                </tr>
              </thead>
              <tbody>
                {h.domains.map((d) => {
                  const quiet = !d.last_ingest_at || Date.now() - d.last_ingest_at > 7 * 86400_000;
                  return (
                    <tr key={d.name} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1.5 font-mono">{d.name}</td>
                      <td>
                        <Badge value={d.status === "active" && d.dns_missing ? "error" : d.status} />
                        {d.dns_missing ? <span className="ml-1 text-xs text-red-600">{d.dns_missing} DNS record(s) missing</span> : null}
                      </td>
                      <td
                        className={quiet ? "text-amber-700 dark:text-amber-400" : ""}
                        title={
                          quiet
                            ? `No mail for 7 days: check ${d.transport === "imap" ? "the mailbox" : "MX records and the Worker"}`
                            : undefined
                        }
                      >
                        {timeAgo(d.last_ingest_at)}
                      </td>
                      <td>
                        {d.transport === "imap" ? `poll ${timeAgo(d.last_poll_at)}` : timeAgo(d.last_checked_at)}
                        {d.last_poll_error && <span className="ml-1 text-xs text-red-600">{d.last_poll_error}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <BackupCard b={h.backup} />
            <ProbeCard p={h.probe} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-5">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Ingest since start</h2>
              {h.ingest.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No mail since the app started.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {[...h.ingest]
                    .sort((a, b) => b.count - a.count)
                    .map((x) => (
                      <li key={`${x.action}-${x.reason}`} className="flex justify-between gap-2">
                        <span>
                          {x.action}
                          {x.reason ? ` · ${x.reason}` : ""}
                        </span>
                        <span className="tabular-nums">{x.count}</span>
                      </li>
                    ))}
                </ul>
              )}
            </section>
            <section className="card p-5">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Background jobs</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {Object.entries(h.jobs).map(([name, j]) => (
                  <li key={name} className="flex flex-wrap justify-between gap-2">
                    <span>{name.replace("_", " ")}</span>
                    <span className={j.ok ? "text-zinc-500" : "text-red-600"}>
                      {j.ok ? "ok" : "failed"} · {timeAgo(j.at)} · {j.detail}
                    </span>
                  </li>
                ))}
                {Object.keys(h.jobs).length === 0 && <li className="text-zinc-500">No run yet.</li>}
              </ul>
              <p className="mt-3 text-xs text-zinc-500">
                Retention: {h.retention_days ? `${h.retention_days} days` : "off"} · Cloudflare:{" "}
                {h.cloudflare === "unconfigured" ? "not configured (IMAP domains only)" : h.cloudflare} · Prometheus /metrics:{" "}
                {h.metrics_enabled ? "on" : "off (set METRICS_TOKEN)"}
              </p>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
