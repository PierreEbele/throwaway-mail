import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, put } from "../../api";
import type { Destination } from "../../types";
import { ErrorText, useToast } from "../../components/ui";
import { invalidate } from "../../queries";

/** The user's fallback chain: mailboxes tried in order when forwarding to the usual one fails. */
export function FallbackCard({ dests }: { dests: Destination[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const verified = dests.filter((d) => d.verified);
  const chain = dests
    .filter((d) => d.fallback_position !== null)
    .sort((a, b) => a.fallback_position! - b.fallback_position!)
    .map((d) => d.id);
  const save = useMutation({
    mutationFn: (ids: string[]) => put("/v1/forwarding/fallbacks", { destination_ids: ids }),
    onSuccess: () => {
      invalidate(qc, ["destinations"]);
      toast("Fallback order saved", "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const move = (i: number, dir: -1 | 1) => {
    const ids = [...chain];
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    save.mutate(ids);
  };
  return (
    <section className="card mt-6 space-y-3 p-5" aria-labelledby="fallbacks">
      <h2 id="fallbacks" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        Fallback mailboxes
      </h2>
      <p className="text-sm text-zinc-500">
        When a mailbox refuses a forward (full, deleted, not verified…), the mail goes to the first fallback that accepts it. An address can
        also have its own fallbacks (on its page).
      </p>
      {chain.length > 0 && (
        <ol className="space-y-1">
          {chain.map((id, i) => {
            const d = dests.find((x) => x.id === id)!;
            return (
              <li key={id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-zinc-500">{i + 1}.</span>
                <span className="font-mono">{d.email}</span>
                <button
                  className="btn-ghost px-1 py-0 text-xs"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${d.email} up`}
                >
                  ▲
                </button>
                <button
                  className="btn-ghost px-1 py-0 text-xs"
                  disabled={i === chain.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${d.email} down`}
                >
                  ▼
                </button>
                <button className="btn-ghost px-1 py-0 text-xs" onClick={() => save.mutate(chain.filter((x) => x !== id))}>
                  remove
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {verified.some((d) => !chain.includes(d.id)) && (
        <select
          aria-label="Add a fallback mailbox"
          className="input w-auto"
          value=""
          onChange={(e) => e.target.value && save.mutate([...chain, e.target.value])}
        >
          <option value="">Add a fallback mailbox…</option>
          {verified
            .filter((d) => !chain.includes(d.id))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.email}
              </option>
            ))}
        </select>
      )}
      {!verified.length && <p className="text-sm text-zinc-500">Verify a mailbox first.</p>}
    </section>
  );
}

/** Original headers kept when forwarding. */
export function HeaderAllowlistCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["forward-headers"],
    queryFn: () => get<{ allowlist: string[] | null; always_kept: string[] }>("/v1/forwarding/headers"),
  });
  const [text, setText] = useState("");
  useEffect(() => {
    if (q.data) setText((q.data.allowlist ?? []).join(", "));
  }, [q.data]);
  const save = useMutation({
    mutationFn: (allowlist: string[] | null) => put("/v1/forwarding/headers", { allowlist }),
    onSuccess: () => {
      invalidate(qc, ["forward-headers"]);
      toast("Saved", "success");
    },
  });
  const on = !!q.data?.allowlist;
  const list = () =>
    text
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <section className="card mt-6 space-y-3 p-5" aria-labelledby="hdr-allow">
      <h2 id="hdr-allow" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        Original headers in forwarded mail
      </h2>
      <p className="text-sm text-zinc-500">
        By default forwarded mail keeps every original header (tracking and mailing-list headers included). You can keep only the ones
        needed to read the mail, plus a few you choose. The full original headers always stay visible here, on each message.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => save.mutate(e.target.checked ? list() : null)} disabled={!q.data} />
        Remove original headers, except the ones listed below
      </label>
      {on && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(list());
          }}
        >
          <label htmlFor="hdr-list" className="label">
            Also keep (comma-separated)
          </label>
          <input
            id="hdr-list"
            className="input font-mono"
            placeholder="List-Unsubscribe, List-Id"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-xs text-zinc-500">Always kept: {q.data?.always_kept.join(", ")}.</p>
          <p className="text-xs text-zinc-500">
            Such copies are sent as new messages from the alias (the Worker needs its SEND_EMAIL binding), with the sender in Reply-To.
          </p>
          <button className="btn-primary" disabled={save.isPending}>
            Save
          </button>
          <ErrorText error={save.error} />
        </form>
      )}
    </section>
  );
}
