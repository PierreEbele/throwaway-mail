import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../api";
import type { AuditEntry, Domain, Invite, User } from "../types";
import { useAuth } from "../auth";
import { Badge, CopyButton, EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../components/ui";
import { useDomains } from "./Addresses";
import { fullDate, timeAgo } from "../util";

const POLICY_HELP: Record<Domain["unknown_policy"], string> = {
  reject: "Reject mail for addresses that do not exist",
  inbox: "Keep it in your “Unassigned” inbox",
  auto_create: "Create the address automatically (catch-all style)",
};

export function DomainsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<Domain["unknown_policy"]>("reject");
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["domains"] });
  };
  const add = useMutation({
    mutationFn: () => post<{ domain: Domain }>("/v1/domains", { name, unknown_policy: policy }),
    onSuccess: (r) => {
      setName("");
      inv();
      toast(`${r.domain.name}: ${r.domain.status}`, r.domain.status === "active" ? "success" : "info");
    },
  });
  const verify = useMutation({
    mutationFn: (id: string) => post<{ domain: Domain }>(`/v1/domains/${id}/verify`),
    onSuccess: (r) => {
      inv();
      toast(`${r.domain.name}: ${r.domain.status}`, r.domain.status === "active" ? "success" : "info");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const setPolicyM = useMutation({ mutationFn: ({ id, p }: { id: string; p: string }) => patch(`/v1/domains/${id}`, { unknown_policy: p }), onSuccess: inv });
  const remove = useMutation({ mutationFn: (id: string) => del(`/v1/domains/${id}`), onSuccess: inv, onError: (e) => toast((e as Error).message, "error") });

  return (
    <>
      <PageHeader title="Domains" subtitle="Shared by all users. Adding a domain enables Cloudflare Email Routing and points its catch-all rule at the Worker." />
      <form
        className="card mb-6 grid gap-3 p-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div>
          <label htmlFor="dom-name" className="label">Domain name</label>
          <input id="dom-name" required className="input" placeholder="mail.example.com" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
        </div>
        <div>
          <label htmlFor="dom-policy" className="label">Unknown addresses</label>
          <select id="dom-policy" className="input" value={policy} onChange={(e) => setPolicy(e.target.value as Domain["unknown_policy"])}>
            {Object.keys(POLICY_HELP).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <button className="btn-primary" disabled={add.isPending}>{add.isPending ? "Configuring Cloudflare…" : "Add domain"}</button>
        <p className="text-xs text-zinc-500 sm:col-span-3">Unknown addresses: {POLICY_HELP[policy]}.</p>
        <div className="sm:col-span-3"><ErrorText error={add.error} /></div>
      </form>
      {domains.isLoading && <Spinner />}
      {domains.data?.length === 0 && <EmptyState title="No domains yet">Add the first domain above. Its DNS must already be on Cloudflare.</EmptyState>}
      <ul className="space-y-3">
        {domains.data?.map((d) => (
          <li key={d.id} className="card p-4" data-testid={`domain-${d.name}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{d.name}</span>
                <Badge value={d.status} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`pol-${d.id}`}>Unknown address policy for {d.name}</label>
                <select id={`pol-${d.id}`} className="input w-auto" value={d.unknown_policy} onChange={(e) => setPolicyM.mutate({ id: d.id, p: e.target.value })}>
                  {Object.keys(POLICY_HELP).map((k) => <option key={k} value={k}>unknown: {k}</option>)}
                </select>
                <button className="btn-secondary" onClick={() => verify.mutate(d.id)} disabled={verify.isPending && verify.variables === d.id}>Re-check</button>
                <button className="btn-ghost text-red-600" onClick={() => confirmAction(`Remove ${d.name}? Only possible when it has no addresses. Cloudflare settings are left untouched.`) && remove.mutate(d.id)}>Remove</button>
              </div>
            </div>
            {d.status_detail && <p className={`mt-2 text-sm ${d.status === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400"}`}>{d.status_detail}</p>}
            {!!d.dns_missing?.length && (
              <div className="mt-3 overflow-x-auto">
                <p className="mb-1 text-sm font-medium">Missing DNS records</p>
                <table className="w-full font-mono text-xs">
                  <thead className="text-left text-zinc-500"><tr><th className="pr-4">Type</th><th className="pr-4">Name</th><th className="pr-4">Content</th><th>Priority</th></tr></thead>
                  <tbody>
                    {d.dns_missing.map((r, i) => (
                      <tr key={i}><td className="pr-4">{r.type}</td><td className="pr-4">{r.name}</td><td className="pr-4 break-all">{r.content}</td><td>{r.priority ?? ""}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-500">Zone {d.cf_zone_id ?? "—"} · last checked {timeAgo(d.last_checked_at)}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

export function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const invites = useQuery({ queryKey: ["admin-invites"], queryFn: () => get<{ invites: Invite[] }>("/v1/admin/invites").then((r) => r.invites) });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [link, setLink] = useState<string | null>(null);
  const createInvite = useMutation({
    mutationFn: () => post<{ url: string }>("/v1/admin/invites", { email: email || undefined, role }),
    onSuccess: (r) => {
      setLink(r.url);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["admin-invites"] });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/v1/admin/invites/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-invites"] }) });
  const updateUser = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patch(`/v1/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <>
      <PageHeader title="Users & invites" subtitle="Access is invite-only. Each user's addresses, messages, destinations and keys are private." />
      <section className="mb-8">
        <h2 className="mb-2 font-semibold">Invite someone</h2>
        <form
          className="card flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createInvite.mutate();
          }}
        >
          <div className="min-w-56 flex-1">
            <label htmlFor="inv-email" className="label">Email <span className="font-normal text-zinc-400">(optional, locks the invite to it)</span></label>
            <input id="inv-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="inv-role" className="label">Role</label>
            <select id="inv-role" className="input" value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button className="btn-primary">Create invite link</button>
          <div className="w-full"><ErrorText error={createInvite.error} /></div>
        </form>
        {link && (
          <div className="card mt-3 border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40" role="alert">
            <p className="text-sm">Send this link to the person (shown once, valid 7 days):</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm break-all" data-testid="invite-link">{link}</code>
              <CopyButton text={link} />
            </div>
          </div>
        )}
      </section>
      <section className="mb-8">
        <h2 className="mb-2 font-semibold">Users</h2>
        {users.isLoading && <Spinner />}
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
          {users.data?.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 truncate">{u.email}</span>
              <Badge value={u.role} />
              {u.disabled && <Badge value="disabled" />}
              {u.id !== me?.id && (
                <>
                  <button className="btn-ghost" onClick={() => updateUser.mutate({ id: u.id, body: { role: u.role === "admin" ? "user" : "admin" } })}>
                    Make {u.role === "admin" ? "user" : "admin"}
                  </button>
                  <button className="btn-ghost" onClick={() => updateUser.mutate({ id: u.id, body: { disabled: !u.disabled } })}>{u.disabled ? "Enable" : "Disable"}</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 font-semibold">Invites</h2>
        {invites.data?.length === 0 && <p className="text-sm text-zinc-500">No invites yet.</p>}
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
          {invites.data?.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className="flex-1">{i.email ?? "(any email)"} · {i.role}</span>
              <Badge value={i.state} />
              <span className="text-xs text-zinc-500">expires {fullDate(i.expires_at)}</span>
              {i.state === "pending" && <button className="btn-ghost text-red-600" onClick={() => revoke.mutate(i.id)}>Revoke</button>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function AuditPage() {
  const log = useQuery({ queryKey: ["audit"], queryFn: () => get<{ entries: AuditEntry[] }>("/v1/admin/audit?limit=200").then((r) => r.entries) });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Admin and security-relevant actions." />
      {log.isLoading && <Spinner />}
      <ErrorText error={log.error} />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500 uppercase"><tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Target</th><th className="px-4 py-2">Details</th><th className="px-4 py-2">IP</th></tr></thead>
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
