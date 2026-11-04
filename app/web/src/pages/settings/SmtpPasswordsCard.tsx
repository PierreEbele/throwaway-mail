import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../../api";
import type { SendingInfo } from "../../types";
import { Badge, CopyButton, ErrorText, confirmAction } from "../../components/ui";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";

/** App passwords for the SMTP submission server (send from an alias with Thunderbird, iOS Mail, Android...). */
export function SmtpPasswordsCard() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["sending"], queryFn: () => get<SendingInfo>("/v1/sending") });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ password: string }>("/v1/sending/passwords", { name }),
    onSuccess: (r) => {
      setCreated(r.password);
      setName("");
      invalidate(qc, ["sending"]);
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/v1/sending/passwords/${id}`),
    onSuccess: () => invalidate(qc, ["sending"]),
  });
  const sub = info.data?.submission;
  return (
    <div className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">Send from your aliases (SMTP)</h2>
      {sub?.enabled ? (
        <>
          <p className="text-zinc-500">
            Add an outgoing (SMTP) server in your mail client, then write from any active alias: the From address must be one of your
            aliases. Recipients become contacts of the alias, so their answers come back through it.
          </p>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
            <dt className="text-zinc-500">Server</dt>
            <dd className="font-mono">{sub.host}</dd>
            <dt className="text-zinc-500">Port</dt>
            <dd className="font-mono">{sub.port}</dd>
            <dt className="text-zinc-500">Security</dt>
            <dd>{sub.security === "implicit" ? "SSL/TLS" : sub.security === "starttls" ? "STARTTLS" : "None (development only)"}</dd>
            <dt className="text-zinc-500">User name</dt>
            <dd className="font-mono">{sub.username}</dd>
            <dt className="text-zinc-500">Password</dt>
            <dd>an SMTP password below (normal password authentication)</dd>
          </dl>
        </>
      ) : (
        <p className="text-zinc-500">
          The SMTP submission server is not enabled on this instance (an admin sets SUBMISSION_PORT). You can still write new mail from an
          address page (New mail) or through the API.
        </p>
      )}
      {info.data && (
        <p className="text-xs text-zinc-500">
          Limit: {info.data.rate_limit_per_hour} mails per hour, {info.data.max_recipients} recipients per mail.
        </p>
      )}
      {created && (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/40" role="alert">
          <p className="font-medium">Copy this SMTP password now. It will not be shown again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-white px-2 py-1 font-mono break-all dark:bg-zinc-900" data-testid="new-smtp-password">
              {created}
            </code>
            <CopyButton text={created} />
            <button className="btn-ghost" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {(info.data?.passwords ?? []).map((p) => (
        <div key={p.id} className={`flex flex-wrap items-center gap-2 ${p.revoked_at ? "opacity-50" : ""}`}>
          <strong>{p.name}</strong>
          <code className="font-mono text-xs">{p.hint}…</code>
          <span className="text-xs text-zinc-500">last used {timeAgo(p.last_used_at)}</span>
          <span className="ml-auto">
            {p.revoked_at ? (
              <Badge value="archived">revoked</Badge>
            ) : (
              <button
                className="btn-ghost px-2 py-0.5 text-xs text-red-600"
                onClick={() => confirmAction(`Revoke "${p.name}"? Mail clients using it will stop sending.`) && revoke.mutate(p.id)}
              >
                Revoke
              </button>
            )}
          </span>
        </div>
      ))}
      <form
        className="flex flex-wrap items-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="min-w-48 flex-1">
          <label htmlFor="smtp-name" className="label">
            New SMTP password for
          </label>
          <input
            id="smtp-name"
            className="input"
            required
            placeholder="e.g. Thunderbird on laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={create.isPending}>
          Create
        </button>
        <div className="w-full">
          <ErrorText error={create.error} />
        </div>
      </form>
    </div>
  );
}
