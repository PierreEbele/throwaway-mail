import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api";
import type { AddressSettingsResponse, Destination, Domain } from "../types";
import { ErrorText, Modal, Toggle, useToast } from "../components/ui";
import { useCategories } from "./mailbox/shared";
import { invalidate } from "../queries";
import { useT } from "../i18n";

export function useDomains() {
  return useQuery({ queryKey: ["domains"], queryFn: () => get<{ domains: Domain[] }>("/v1/domains").then((r) => r.domains) });
}
export function useAddressSettings(enabled = true) {
  return useQuery({
    queryKey: ["address-settings"],
    queryFn: () => get<AddressSettingsResponse>("/v1/settings/addresses"),
    enabled,
    staleTime: 0,
  });
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
  const t = useT().newAddress;
  const tc = useT().common;
  const [siteName, setSiteName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [forward, setForward] = useState(false);
  const [destinationId, setDestinationId] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [maxMessages, setMaxMessages] = useState("");
  const categories = useCategories(open);
  const [categoryId, setCategoryId] = useState("");
  const prefs = useAddressSettings(open);
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
  // Defaults from Account -> New addresses, shown so they can be changed or cleared for this address.
  useEffect(() => {
    if (!open || !prefs.data) return;
    setExpiresDays(prefs.data.settings.default_expires_in_days ? String(prefs.data.settings.default_expires_in_days) : "");
    setMaxMessages(prefs.data.settings.default_max_messages ? String(prefs.data.settings.default_max_messages) : "");
  }, [open, prefs.data]);
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
        // Blank means none here: the form already showed the account defaults.
        ...(expiresDays ? { expires_in_days: Number(expiresDays) } : { expires_at: null }),
        max_messages: maxMessages ? Number(maxMessages) : null,
      }),
    onSuccess: (r) => {
      invalidate(qc, ["addresses"], ["categories"]);
      toast(t.created(r.email), "success");
      onClose();
      nav(`/addresses/${r.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal open={open} onClose={onClose} title={t.title}>
      {active.length === 0 && !domains.isLoading ? (
        <p className="text-sm">
          {t.noDomain1} <strong>{t.noDomain2}</strong>.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="na-site" className="label">
              {t.siteName}
            </label>
            <input
              id="na-site"
              className="input"
              required
              autoFocus
              placeholder={t.siteNamePlaceholder}
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="na-url" className="label">
              {t.siteUrl} <span className="font-normal text-zinc-400">{t.optional}</span>
            </label>
            <input id="na-url" className="input" placeholder="github.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="na-local" className="label">
                {t.localPart} <span className="font-normal text-zinc-400">{t.blankRandom}</span>
              </label>
              <input
                id="na-local"
                className="input font-mono"
                placeholder={prefs.data?.examples[0] ?? "amber-otter-1234"}
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
              />
            </div>
            <div>
              <label htmlFor="na-domain" className="label">
                {t.domain}
              </label>
              <select id="na-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
                <option value="">
                  {t.automatic}
                  {suggestion.data?.domain ? ` (@${suggestion.data.domain})` : ""}
                </option>
                {active.map((d) => (
                  <option key={d.id} value={d.name}>
                    @{d.name}
                  </option>
                ))}
              </select>
              {avoided.length > 0 && (
                <p className={`mt-1 text-xs ${avoided.includes(domain) ? "text-amber-700 dark:text-amber-400" : "text-zinc-500"}`}>
                  {t.rejectedBefore(avoided.map((x) => `@${x}`).join(", "))}
                  {avoided.includes(domain) ? t.pickAnother : t.autoSkips}
                </p>
              )}
            </div>
          </div>
          {(categories.data?.length ?? 0) > 0 && (
            <div>
              <label htmlFor="na-cat" className="label">
                {t.category}
              </label>
              <select id="na-cat" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t.noCategory}</option>
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
                {t.expires}
              </label>
              <select id="na-expires" className="input" value={expiresDays} onChange={(e) => setExpiresDays(e.target.value)}>
                <option value="">{t.never}</option>
                <option value="1">{t.afterDays(1)}</option>
                <option value="7">{t.afterDays(7)}</option>
                <option value="30">{t.afterDays(30)}</option>
                <option value="90">{t.afterDays(90)}</option>
                <option value="365">{t.afterYear}</option>
                {expiresDays && !["1", "7", "30", "90", "365"].includes(expiresDays) && (
                  <option value={expiresDays}>{t.afterDays(Number(expiresDays))}</option>
                )}
              </select>
            </div>
            <div>
              <label htmlFor="na-max" className="label">
                {t.maxMails} <span className="font-normal text-zinc-400">{t.blankUnlimited}</span>
              </label>
              <input
                id="na-max"
                className="input"
                type="number"
                min={1}
                max={100000}
                placeholder={t.maxPlaceholder}
                value={maxMessages}
                onChange={(e) => setMaxMessages(e.target.value)}
              />
            </div>
          </div>
          {(expiresDays || maxMessages) && <p className="-mt-2 text-xs text-zinc-500">{t.expiredNote}</p>}
          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="na-forward" className="text-sm font-medium">
                {t.alsoForward}
              </label>
              <Toggle id="na-forward" checked={forward} onChange={setForward} label={t.forwardLabel} />
            </div>
            {forward && (
              <div className="mt-3">
                {verified.length === 0 ? (
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    {t.noVerified}{" "}
                    <Link className="underline" to="/destinations" onClick={onClose}>
                      {t.addOne}
                    </Link>
                    {t.storedUntil}
                  </p>
                ) : (
                  <>
                    <label htmlFor="na-dest" className="label">
                      {t.destination}
                    </label>
                    <select id="na-dest" className="input" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                      <option value="">{t.defaultDest}</option>
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
              {tc.cancel}
            </button>
            <button className="btn-primary" disabled={create.isPending}>
              {create.isPending ? t.creating : t.create}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
