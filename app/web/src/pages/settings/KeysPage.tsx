import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../../api";
import type { ApiKey } from "../../types";
import { Badge, CopyButton, EmptyState, ErrorText, PageHeader, Spinner, confirmAction } from "../../components/ui";
import { invalidate } from "../../queries";
import { fullDate, timeAgo } from "../../util";

export function KeysPage() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => get<{ keys: ApiKey[] }>("/v1/keys").then((r) => r.keys) });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ key: string }>("/v1/keys", { name }),
    onSuccess: (r) => {
      setCreated(r.key);
      setName("");
      invalidate(qc, ["keys"]);
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/v1/keys/${id}`), onSuccess: () => invalidate(qc, ["keys"]) });
  const origin = location.origin;
  return (
    <>
      <PageHeader title="API keys" subtitle="Use a key as a Bearer token. Keys are stored hashed; the full key is shown only once." />
      <form
        className="card mb-4 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="key-name" className="label">
            Key name
          </label>
          <input
            id="key-name"
            required
            className="input"
            placeholder="e.g. signup-bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={create.isPending}>
          Create key
        </button>
        <div className="w-full">
          <ErrorText error={create.error} />
        </div>
      </form>
      {created && (
        <div className="card mb-6 border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40" role="alert">
          <p className="text-sm font-medium">Copy your new key now. It will not be shown again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-white px-2 py-1 font-mono text-sm break-all dark:bg-zinc-900" data-testid="new-key">
              {created}
            </code>
            <CopyButton text={created} />
            <button className="btn-ghost" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
          <pre className="mt-3 overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-100">{`curl -s -H "Authorization: Bearer ${created}" \\
  -H "Content-Type: application/json" \\
  -d '{"site_name":"Example"}' ${origin}/v1/addresses`}</pre>
        </div>
      )}
      {keys.isLoading && <Spinner />}
      {keys.data?.length === 0 && <EmptyState title="No API keys" />}
      {!!keys.data?.length && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Prefix</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {keys.data.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                  <td className="px-4 py-2">{k.name}</td>
                  <td className="px-4 py-2 font-mono">{k.prefix}…</td>
                  <td className="px-4 py-2">{fullDate(k.created_at)}</td>
                  <td className="px-4 py-2">{timeAgo(k.last_used_at)}</td>
                  <td className="px-4 py-2 text-right">
                    {k.revoked_at ? (
                      <Badge value="archived">revoked</Badge>
                    ) : (
                      <button
                        className="btn-ghost text-red-600"
                        onClick={() => confirmAction(`Revoke "${k.name}"? Programs using it will stop working.`) && revoke.mutate(k.id)}
                      >
                        Revoke
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
