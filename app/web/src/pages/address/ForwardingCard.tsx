import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { Address, Destination } from "../../types";
import { Toggle } from "../../components/ui";
import { fullDate, timeAgo } from "../../util";

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
