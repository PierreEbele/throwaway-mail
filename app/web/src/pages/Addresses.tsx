import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api";
import type { Address, Destination, Domain } from "../types";
import { Badge, CopyButton, EmptyState, ErrorText, Modal, PageHeader, Spinner, Toggle, useToast } from "../components/ui";
import { hostOf, timeAgo } from "../util";

export function useDomains() {
  return useQuery({ queryKey: ["domains"], queryFn: () => get<{ domains: Domain[] }>("/v1/domains").then((r) => r.domains) });
}
export function useDestinations() {
  return useQuery({ queryKey: ["destinations"], queryFn: () => get<{ destinations: Destination[] }>("/v1/destinations").then((r) => r.destinations) });
}

export function NewAddressDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const domains = useDomains();
  const dests = useDestinations();
  const active = (domains.data ?? []).filter((d) => d.status === "active");
  const [domain, setDomain] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [forward, setForward] = useState(false);
  const [destinationId, setDestinationId] = useState("");
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  useEffect(() => {
    if (!open) {
      setSiteName("");
      setSiteUrl("");
      setLocalPart("");
      setForward(false);
    }
  }, [open]);
  useEffect(() => {
    if (!domain && active[0]) setDomain(active[0].name);
  }, [active, domain]);
  const verified = (dests.data ?? []).filter((d) => d.verified);
  const create = useMutation({
    mutationFn: () =>
      post<{ id: string; email: string }>("/v1/addresses", {
        domain: domain || undefined,
        site_name: siteName,
        site_url: siteUrl || undefined,
        local_part: localPart.trim() || undefined,
        forward,
        destination_id: forward && destinationId ? destinationId : undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["addresses"] });
      toast(`Created ${r.email}`, "success");
      onClose();
      nav(`/addresses/${r.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal open={open} onClose={onClose} title="New address">
      {active.length === 0 && !domains.isLoading ? (
        <p className="text-sm">No active domain yet. An admin must add one under <strong>Admin → Domains</strong>.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="na-site" className="label">Site name</label>
            <input id="na-site" className="input" required autoFocus placeholder="e.g. GitHub" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="na-url" className="label">Site URL <span className="font-normal text-zinc-400">(optional)</span></label>
            <input id="na-url" className="input" placeholder="github.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="na-local" className="label">Local part <span className="font-normal text-zinc-400">(blank = random)</span></label>
              <input id="na-local" className="input font-mono" placeholder="amber-otter-1234" value={localPart} onChange={(e) => setLocalPart(e.target.value.toLowerCase())} />
            </div>
            <div>
              <label htmlFor="na-domain" className="label">Domain</label>
              <select id="na-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
                {active.map((d) => (
                  <option key={d.id} value={d.name}>@{d.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="na-forward" className="text-sm font-medium">Also forward mail to my personal mailbox</label>
              <Toggle id="na-forward" checked={forward} onChange={setForward} label="Forward mail for this site" />
            </div>
            {forward && (
              <div className="mt-3">
                {verified.length === 0 ? (
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    You have no verified destination yet. <Link className="underline" to="/destinations" onClick={onClose}>Add one</Link>; mail is stored (not forwarded) until it is verified.
                  </p>
                ) : (
                  <>
                    <label htmlFor="na-dest" className="label">Destination</label>
                    <select id="na-dest" className="input" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                      <option value="">Default (first verified)</option>
                      {verified.map((d) => (
                        <option key={d.id} value={d.id}>{d.email}</option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            )}
          </div>
          <ErrorText error={create.error} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create address"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function AddressesPage() {
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debounced) p.set("q", debounced);
    if (domain) p.set("domain", domain);
    if (status) p.set("status", status);
    return p.toString();
  }, [debounced, domain, status]);
  const list = useQuery({ queryKey: ["addresses", params], queryFn: () => get<{ addresses: Address[] }>(`/v1/addresses?${params}`).then((r) => r.addresses) });
  const domains = useDomains();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        setCreating(true);
      }
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        document.getElementById("addr-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <PageHeader
        title="Addresses"
        subtitle={<>One address per site. Press <kbd className="rounded border px-1 text-xs">n</kbd> to create, <kbd className="rounded border px-1 text-xs">/</kbd> to search.</>}
        actions={<button className="btn-primary" onClick={() => setCreating(true)}>+ New address</button>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="addr-search">Search addresses</label>
        <input id="addr-search" type="search" className="input max-w-xs" placeholder="Search site, address, label…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr-only" htmlFor="addr-domain">Filter by domain</label>
        <select id="addr-domain" className="input w-auto" value={domain} onChange={(e) => setDomain(e.target.value)}>
          <option value="">All domains</option>
          {(domains.data ?? []).map((d) => (
            <option key={d.id} value={d.name}>{d.name}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="addr-status">Filter by status</label>
        <select id="addr-status" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Active &amp; paused</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
      </div>
      {list.isLoading && <Spinner />}
      <ErrorText error={list.error} />
      {list.data && list.data.length === 0 && (
        <EmptyState title={debounced || domain || status ? "No matching addresses" : "No addresses yet"}>
          {!debounced && <button className="btn-primary mt-2" onClick={() => setCreating(true)}>Create your first address</button>}
        </EmptyState>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800" aria-label="Addresses">
          {list.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              <Link to={`/addresses/${a.id}`} className="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-indigo-500" aria-label={`${a.site_name}, ${a.email}${a.unread_count ? `, ${a.unread_count} unread` : ""}`}>
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{a.site_name}</span>
                  {a.site_url && <span className="truncate text-xs text-zinc-500">{hostOf(a.site_url)}</span>}
                  {a.unread_count > 0 && <span className="badge bg-indigo-600 text-white">{a.unread_count} new</span>}
                </div>
                <div className="truncate font-mono text-sm text-zinc-600 dark:text-zinc-400">{a.email}</div>
              </Link>
              <div className="flex items-center gap-3 text-xs text-zinc-500">
                {a.forward_enabled && <span title="Forwarding enabled">↪ fwd</span>}
                {a.status !== "active" && <Badge value={a.status} />}
                <span className="hidden sm:inline">{a.message_count} msg · {timeAgo(a.last_message_at ?? a.created_at)}</span>
                <CopyButton text={a.email} className="btn-ghost px-2 py-1 text-xs" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <NewAddressDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
