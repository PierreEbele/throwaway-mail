import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch } from "../../api";
import type { Address } from "../../types";
import { CopyButton, Toggle } from "../../components/ui";
import { timeAgo } from "../../util";

interface Contact {
  id: string;
  email: string;
  name: string | null;
  reverse_address: string;
  blocked: boolean;
  last_reply_at: number | null;
  reply_count: number;
}

/** Reverse-alias replies: toggle, explanation, and the senders that got a reply address. */
export function RepliesCard({ a, onChange }: { a: Address; onChange: (b: Record<string, unknown>) => void }) {
  const qc = useQueryClient();
  const contacts = useQuery({
    queryKey: ["contacts", a.id],
    queryFn: () => get<{ contacts: Contact[] }>(`/v1/addresses/${a.id}/contacts`).then((r) => r.contacts),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["contacts", a.id] });
  const block = useMutation({
    mutationFn: (c: Contact) => patch(`/v1/addresses/${a.id}/contacts/${c.id}`, { blocked: !c.blocked }),
    onSuccess: refresh,
  });
  const forget = useMutation({ mutationFn: (c: Contact) => del(`/v1/addresses/${a.id}/contacts/${c.id}`), onSuccess: refresh });
  const unavailable = a.replies_unavailable;
  return (
    <section className="card space-y-3 p-5" aria-labelledby="replies">
      <h2 id="replies" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        Replies
      </h2>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="replies-toggle" className="text-sm">
          Reply from this address
          <span className="block text-xs text-zinc-500">
            Forwarded mail gets a private reply address per sender. Replying from your verified mailbox sends the answer from {a.email};
            your own address is never shown.
          </span>
        </label>
        <Toggle
          id="replies-toggle"
          checked={a.replies_enabled}
          disabled={!!unavailable && !a.replies_enabled}
          onChange={(v) => onChange({ replies_enabled: v })}
          label="Reverse-alias replies"
        />
      </div>
      {unavailable && <p className="text-xs text-amber-700 dark:text-amber-400">Unavailable: {unavailable}</p>}
      {a.replies_enabled && !a.forward_enabled && (
        <p className="text-xs text-zinc-500">Turn forwarding on: reply addresses are only added to forwarded mail.</p>
      )}
      {(contacts.data?.length ?? 0) > 0 && (
        <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          {contacts.data!.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className={c.blocked ? "text-zinc-400 line-through" : ""}>
                {c.name ? `${c.name} · ` : ""}
                {c.email}
                <span className="block text-xs text-zinc-500">
                  {c.reply_count} repl{c.reply_count === 1 ? "y" : "ies"}
                  {c.last_reply_at ? `, last ${timeAgo(c.last_reply_at)}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <CopyButton text={c.reverse_address} label="Copy reply address" />
                <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => block.mutate(c)}>
                  {c.blocked ? "Unblock" : "Block"}
                </button>
                <button className="btn-ghost px-2 py-0.5 text-xs text-red-600" onClick={() => forget.mutate(c)}>
                  Forget
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
