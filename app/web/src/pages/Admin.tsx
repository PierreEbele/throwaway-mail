import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../api";
import type { AuditEntry, Domain, User } from "../types";
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
  const setForwardUnknown = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => patch(`/v1/domains/${id}`, { forward_unknown: on }),
    onSuccess: inv,
    onError: (e) => toast((e as Error).message, "error"),
  });
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
            {d.previous_catch_all && (() => {
              const oldFwd = d.previous_catch_all.actions.find((a) => a.type === "forward")?.value?.[0];
              return (
                <div className="mt-2 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
                  <p>
                    Catch-all before the app: <strong>{d.previous_catch_all.actions.map((a) => `${a.type}${a.value ? " → " + a.value.join(", ") : ""}`).join("; ")}</strong>.
                    {" "}It is restored if you remove the domain here.
                  </p>
                  {oldFwd && (
                    <p className="mt-1 flex flex-wrap items-center gap-2">
                      {d.catchall_forward_to ? (
                        <>Unknown addresses are still forwarded to {d.catchall_forward_to} and listed under “To sort”.
                          <button className="btn-ghost" onClick={() => confirmAction(`Stop forwarding unknown addresses to ${oldFwd}? The "${d.unknown_policy}" policy will apply instead.`) && setForwardUnknown.mutate({ id: d.id, on: false })}>Stop forwarding</button></>
                      ) : (
                        <>Unknown addresses follow the “{d.unknown_policy}” policy.
                          <button className="btn-ghost" onClick={() => setForwardUnknown.mutate({ id: d.id, on: true })}>Forward them to {oldFwd} again</button></>
                      )}
                    </p>
                  )}
                </div>
              );
            })()}
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
  const { user: me, ssoProvider } = useAuth();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const updateUser = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => patch(`/v1/admin/users/${id}`, { disabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <>
      <PageHeader
        title="Users"
        subtitle={`Accounts are created automatically at the first ${ssoProvider} sign-in. Roles follow ${ssoProvider} groups. Each user's addresses, messages, destinations and keys are private.`}
      />
      {users.isLoading && <Spinner />}
      <ErrorText error={users.error} />
      <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
        {users.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate">{u.name ?? u.email}</div>
              <div className="truncate text-xs text-zinc-500">{u.email} · last sign-in {timeAgo(u.last_login_at)}</div>
            </div>
            <Badge value={u.role} />
            {u.disabled && <Badge value="disabled" />}
            {u.id !== me?.id && (
              <button
                className="btn-ghost"
                onClick={() => (u.disabled || confirmAction(`Disable ${u.email}? They are signed out and their API keys stop working.`)) && updateUser.mutate({ id: u.id, disabled: !u.disabled })}
              >
                {u.disabled ? "Enable" : "Disable"}
              </button>
            )}
          </li>
        ))}
      </ul>
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
