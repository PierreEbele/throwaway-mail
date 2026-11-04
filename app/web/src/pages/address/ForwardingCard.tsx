import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { put } from "../../api";
import type { Address, Destination } from "../../types";
import { Toggle, useToast } from "../../components/ui";
import { invalidateAddress } from "../../queries";
import { fullDate, timeAgo } from "../../util";

/** This address's own fallback mailboxes, in order (none: the account's fallback chain on the Destinations page). */
function AddressFallbacks({ a, verified }: { a: Address; verified: Destination[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = a.fallback_destination_ids ?? [];
  const save = useMutation({
    mutationFn: (next: string[]) => put(`/v1/addresses/${a.id}/fallbacks`, { destination_ids: next }),
    onSuccess: () => invalidateAddress(qc, a.id),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const email = (id: string) => verified.find((d) => d.id === id)?.email ?? "(removed mailbox)";
  return (
    <div>
      <p className="label">If forwarding fails, try</p>
      {ids.length ? (
        <ol className="space-y-1 text-sm">
          {ids.map((id, i) => (
            <li key={id} className="flex items-center gap-2">
              <span className="text-zinc-500">{i + 1}.</span> {email(id)}
              <button className="btn-ghost px-1 py-0 text-xs" onClick={() => save.mutate(ids.filter((x) => x !== id))}>
                remove
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-zinc-500">
          The account's fallback mailboxes (
          <Link to="/destinations" className="underline">
            Destinations
          </Link>
          ).
        </p>
      )}
      {verified.some((d) => !ids.includes(d.id)) && (
        <select
          aria-label="Add a fallback mailbox for this address"
          className="input mt-1 w-auto text-sm"
          value=""
          onChange={(e) => e.target.value && save.mutate([...ids, e.target.value])}
        >
          <option value="">Add a fallback for this address…</option>
          {verified
            .filter((d) => !ids.includes(d.id))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.email}
              </option>
            ))}
        </select>
      )}
    </div>
  );
}

export function ForwardingCard({
  a,
  dests,
  onUpdate,
}: {
  a: Address;
  dests: Destination[] | undefined;
  onUpdate: (body: Record<string, unknown>) => void;
}) {
  const verified = useMemo(() => (dests ?? []).filter((d) => d.verified), [dests]);
  const forwardTarget = a.destination_id ? dests?.find((d) => d.id === a.destination_id) : verified[0];
  const forwardWarning = a.forward_enabled && (!forwardTarget || !forwardTarget.verified);
  return (
    <section className="card space-y-4 p-5" aria-labelledby="forwarding">
      <h2 id="forwarding" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        Forwarding for this site
      </h2>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="fwd-toggle" className="text-sm">
          Forward new mail to my mailbox
        </label>
        <Toggle
          id="fwd-toggle"
          checked={a.forward_enabled}
          onChange={(v) => onUpdate({ forward_enabled: v })}
          label="Forward new mail for this site"
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="promo-toggle" className="text-sm">
          Reject newsletters &amp; promotions{" "}
          <span className="block text-xs text-zinc-500">Mail with a verification code still gets through.</span>
        </label>
        <Toggle
          id="promo-toggle"
          checked={a.block_promos}
          onChange={(v) => onUpdate({ block_promos: v })}
          label="Reject newsletters and promotions"
        />
      </div>
      <div>
        <label htmlFor="fwd-dest" className="label">
          Destination
        </label>
        <select
          id="fwd-dest"
          className="input"
          value={a.destination_id ?? ""}
          onChange={(e) => onUpdate({ destination_id: e.target.value || null })}
        >
          <option value="">Default (first verified)</option>
          {(dests ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.email}
              {d.verified ? "" : " (unverified)"}
            </option>
          ))}
        </select>
      </div>
      {(dests ?? []).length > 1 && (
        <fieldset>
          <legend className="label">Also forward to</legend>
          <div className="space-y-1">
            {(dests ?? [])
              .filter((d) => d.id !== (a.destination_id ?? verified[0]?.id))
              .map((d) => {
                const extra = a.extra_destination_ids ?? [];
                const on = extra.includes(d.id);
                return (
                  <label key={d.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => onUpdate({ extra_destination_ids: on ? extra.filter((x) => x !== d.id) : [...extra, d.id] })}
                    />
                    {d.email}
                    {!d.verified && <span className="text-xs text-zinc-500">(unverified, skipped)</span>}
                  </label>
                );
              })}
          </div>
        </fieldset>
      )}
      {forwardWarning && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Forwarding is on but the destination is not verified, so mail is only stored.{" "}
          <Link to="/destinations" className="underline">
            Manage destinations
          </Link>
        </p>
      )}
      {verified.length > 1 && <AddressFallbacks a={a} verified={verified} />}
      <p className="text-xs text-zinc-500">Changes apply to the next mail received.</p>
      <dl className="grid grid-cols-2 gap-1 text-xs text-zinc-500">
        <dt>Created</dt>
        <dd>{fullDate(a.created_at)}</dd>
        <dt>Last mail</dt>
        <dd>{timeAgo(a.last_message_at)}</dd>
        <dt>Expires</dt>
        <dd>{a.expires_at ? fullDate(a.expires_at) : "never"}</dd>
      </dl>
    </section>
  );
}
