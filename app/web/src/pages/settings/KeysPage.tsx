import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../../api";
import type { Address, ApiKey } from "../../types";
import { Badge, CopyButton, EmptyState, ErrorText, PageHeader, Spinner, confirmAction } from "../../components/ui";
import { invalidate } from "../../queries";
import { fullDate, timeAgo } from "../../util";
import { useT } from "../../i18n";

export function KeysPage() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => get<{ keys: ApiKey[] }>("/v1/keys").then((r) => r.keys) });
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"full" | "read">("full");
  const [restrict, setRestrict] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  const t = useT().settings.keys;
  const [created, setCreated] = useState<string | null>(null);
  const addrs = useQuery({
    queryKey: ["addresses", "key-picker"],
    queryFn: () => get<{ addresses: Address[] }>("/v1/addresses?status=all&limit=1000").then((r) => r.addresses),
    enabled: restrict,
  });
  const addrLabel = new Map((addrs.data ?? []).map((a) => [a.id, a.email]));
  const create = useMutation({
    mutationFn: () =>
      post<{ key: string }>("/v1/keys", {
        name,
        scope,
        address_ids: restrict ? [...picked] : null,
        expires_in_days: expiryDays ? Number(expiryDays) : undefined,
      }),
    onSuccess: (r) => {
      setCreated(r.key);
      setName("");
      setScope("full");
      setRestrict(false);
      setPicked(new Set());
      setExpiryDays("");
      invalidate(qc, ["keys"]);
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/v1/keys/${id}`), onSuccess: () => invalidate(qc, ["keys"]) });
  const origin = location.origin;
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <form
        className="card mb-4 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="key-name" className="label">
            {t.name}
          </label>
          <input
            id="key-name"
            required
            className="input"
            placeholder={t.placeholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="key-scope" className="label">
            {t.access}
          </label>
          <select id="key-scope" className="input" value={scope} onChange={(e) => setScope(e.target.value as "full" | "read")}>
            <option value="full">{t.scopeFull}</option>
            <option value="read">{t.scopeRead}</option>
          </select>
        </div>
        <div>
          <label htmlFor="key-expiry" className="label">
            {t.expires}
          </label>
          <select id="key-expiry" className="input" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}>
            <option value="">{t.never}</option>
            {[1, 7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {t.inDays(d)}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary" disabled={create.isPending || (restrict && picked.size === 0)}>
          {t.create}
        </button>
        <div className="w-full">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
            {t.restrict}
          </label>
          {restrict && (
            <div className="mt-2 rounded border border-zinc-200 p-2 dark:border-zinc-800">
              <input
                className="input mb-2"
                placeholder={t.filter}
                aria-label={t.filter}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {addrs.isLoading && <Spinner />}
              <div className="max-h-48 overflow-auto text-sm">
                {(addrs.data ?? [])
                  .filter((a) => !filter || `${a.email} ${a.site_name}`.toLowerCase().includes(filter.toLowerCase()))
                  .map((a) => (
                    <label key={a.id} className="flex items-center gap-2 py-0.5">
                      <input
                        type="checkbox"
                        checked={picked.has(a.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(a.id);
                          else next.delete(a.id);
                          setPicked(next);
                        }}
                      />
                      <span className="font-mono">{a.email}</span>
                      <span className="text-zinc-500">{a.site_name}</span>
                    </label>
                  ))}
              </div>
              <p className="mt-1 text-xs text-zinc-500">{t.selected(picked.size)}</p>
            </div>
          )}
        </div>
        <div className="w-full">
          <ErrorText error={create.error} />
        </div>
      </form>
      {created && (
        <div className="card mb-6 border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40" role="alert">
          <p className="text-sm font-medium">{t.copyNow}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-white px-2 py-1 font-mono text-sm break-all dark:bg-zinc-900" data-testid="new-key">
              {created}
            </code>
            <CopyButton text={created} />
            <button className="btn-ghost" onClick={() => setCreated(null)}>
              {t.done}
            </button>
          </div>
          <pre className="mt-3 overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-100">{`curl -s -H "Authorization: Bearer ${created}" \\
  -H "Content-Type: application/json" \\
  -d '{"site_name":"Example"}' ${origin}/v1/addresses`}</pre>
        </div>
      )}
      {keys.isLoading && <Spinner />}
      {keys.data?.length === 0 && <EmptyState title={t.empty} />}
      {!!keys.data?.length && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-2">{t.colName}</th>
                <th className="px-4 py-2">{t.prefix}</th>
                <th className="px-4 py-2">{t.scope}</th>
                <th className="px-4 py-2">{t.expires}</th>
                <th className="px-4 py-2">{t.created}</th>
                <th className="px-4 py-2">{t.lastUsed}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {keys.data.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                  <td className="px-4 py-2">{k.name}</td>
                  <td className="px-4 py-2 font-mono">{k.prefix}…</td>
                  <td className="px-4 py-2">
                    {k.scope === "read" ? t.scopeRead : t.scopeFullShort}
                    {k.address_ids && (
                      <span className="block text-xs text-zinc-500" title={k.address_ids.map((id) => addrLabel.get(id) ?? id).join(", ")}>
                        {t.addressCount(k.address_ids.length)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {k.expires_at ? (
                      <span className={k.expires_at < Date.now() ? "text-red-600" : ""}>{fullDate(k.expires_at)}</span>
                    ) : (
                      t.never
                    )}
                  </td>
                  <td className="px-4 py-2">{fullDate(k.created_at)}</td>
                  <td className="px-4 py-2">{timeAgo(k.last_used_at)}</td>
                  <td className="px-4 py-2 text-right">
                    {k.revoked_at ? (
                      <Badge value="archived">{t.revoked}</Badge>
                    ) : (
                      <button
                        className="btn-ghost text-red-600"
                        onClick={() => confirmAction(t.confirmRevoke(k.name)) && revoke.mutate(k.id)}
                      >
                        {t.revoke}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
