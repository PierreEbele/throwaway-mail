import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api";
import type { Destination, Domain } from "../types";
import { ErrorText, Modal, Toggle, useToast } from "../components/ui";
import { useCategories } from "./mailbox/shared";
import { invalidate } from "../queries";

export function useDomains() {
  return useQuery({ queryKey: ["domains"], queryFn: () => get<{ domains: Domain[] }>("/v1/domains").then((r) => r.domains) });
}
export function useDestinations() {
  return useQuery({
    queryKey: ["destinations"],
    queryFn: () => get<{ destinations: Destination[] }>("/v1/destinations").then((r) => r.destinations),
  });
}

export function NewAddressDialog({ open, onClose, defaultCategory }: { open: boolean; onClose: () => void; defaultCategory?: string }) {
  const domains = useDomains();
  const dests = useDestinations();
  const active = (domains.data ?? []).filter((d) => d.status === "active");
  const [domain, setDomain] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [forward, setForward] = useState(false);
  const [destinationId, setDestinationId] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [maxMessages, setMaxMessages] = useState("");
  const categories = useCategories(open);
  const [categoryId, setCategoryId] = useState("");
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  useEffect(() => {
    if (!open) {
      setSiteName("");
      setSiteUrl("");
      setLocalPart("");
      setForward(false);
      setExpiresDays("");
      setMaxMessages("");
    } else setCategoryId(defaultCategory ?? "");
  }, [open, defaultCategory]);
  // "Automatic": the server applies the domain choice and skips domains this site is known to reject.
  const [siteQuery, setSiteQuery] = useState({ name: "", url: "" });
  useEffect(() => {
    const t = setTimeout(() => setSiteQuery({ name: siteName.trim(), url: siteUrl.trim() }), 300);
    return () => clearTimeout(t);
  }, [siteName, siteUrl]);
  const suggestion = useQuery({
    queryKey: ["site-domain", siteQuery],
    enabled: open && active.length > 1,
    queryFn: () =>
      get<{ domain: string | null; avoided: string[] }>(
        `/v1/sites/domain?${new URLSearchParams({ site_name: siteQuery.name, site_url: siteQuery.url })}`,
      ),
  });
  const avoided = suggestion.data?.avoided ?? [];
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
        category_id: categoryId || undefined,
        expires_in_days: expiresDays ? Number(expiresDays) : undefined,
        max_messages: maxMessages ? Number(maxMessages) : undefined,
      }),
    onSuccess: (r) => {
      invalidate(qc, ["addresses"], ["categories"]);
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
        <p className="text-sm">
          No active domain yet. An admin must add one under <strong>Admin → Domains</strong>.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="na-site" className="label">
              Site name
            </label>
            <input
              id="na-site"
              className="input"
              required
              autoFocus
              placeholder="e.g. GitHub"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="na-url" className="label">
              Site URL <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <input id="na-url" className="input" placeholder="github.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="na-local" className="label">
                Local part <span className="font-normal text-zinc-400">(blank = random)</span>
              </label>
              <input
                id="na-local"
                className="input font-mono"
                placeholder="amber-otter-1234"
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
              />
            </div>
            <div>
              <label htmlFor="na-domain" className="label">
                Domain
              </label>
              <select id="na-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
                <option value="">Automatic{suggestion.data?.domain ? ` (@${suggestion.data.domain})` : ""}</option>
                {active.map((d) => (
                  <option key={d.id} value={d.name}>
                    @{d.name}
                  </option>
                ))}
              </select>
              {avoided.length > 0 && (
                <p className={`mt-1 text-xs ${avoided.includes(domain) ? "text-amber-700 dark:text-amber-400" : "text-zinc-500"}`}>
                  This site rejected {avoided.map((x) => `@${x}`).join(", ")} before
                  {avoided.includes(domain) ? ": pick another domain or Automatic." : "; Automatic skips it."}
                </p>
              )}
            </div>
          </div>
          {(categories.data?.length ?? 0) > 0 && (
            <div>
              <label htmlFor="na-cat" className="label">
                Category
              </label>
              <select id="na-cat" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">No category</option>
                {categories.data!.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="na-expires" className="label">
                Expires
              </label>
              <select id="na-expires" className="input" value={expiresDays} onChange={(e) => setExpiresDays(e.target.value)}>
                <option value="">Never</option>
                <option value="1">After 1 day</option>
                <option value="7">After 7 days</option>
                <option value="30">After 30 days</option>
                <option value="90">After 90 days</option>
                <option value="365">After 1 year</option>
              </select>
            </div>
            <div>
              <label htmlFor="na-max" className="label">
                Max mails <span className="font-normal text-zinc-400">(blank = unlimited)</span>
              </label>
              <input
                id="na-max"
                className="input"
                type="number"
                min={1}
                max={100000}
                placeholder="e.g. 3"
                value={maxMessages}
                onChange={(e) => setMaxMessages(e.target.value)}
              />
            </div>
          </div>
          {(expiresDays || maxMessages) && (
            <p className="-mt-2 text-xs text-zinc-500">
              Once expired or full, the address is paused automatically and new mail is rejected.
            </p>
          )}
          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="na-forward" className="text-sm font-medium">
                Also forward mail to my personal mailbox
              </label>
              <Toggle id="na-forward" checked={forward} onChange={setForward} label="Forward mail for this site" />
            </div>
            {forward && (
              <div className="mt-3">
                {verified.length === 0 ? (
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    You have no verified destination yet.{" "}
                    <Link className="underline" to="/destinations" onClick={onClose}>
                      Add one
                    </Link>
                    ; mail is stored (not forwarded) until it is verified.
                  </p>
                ) : (
                  <>
                    <label htmlFor="na-dest" className="label">
                      Destination
                    </label>
                    <select id="na-dest" className="input" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                      <option value="">Default (first verified)</option>
                      {verified.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.email}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            )}
          </div>
          <ErrorText error={create.error} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create address"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
