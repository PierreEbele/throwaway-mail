import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address, MessageSummary } from "../../types";
import { EmptyState, Spinner, confirmAction, useToast } from "../../components/ui";
import { PaperclipIcon } from "../../components/icons";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { MessageView } from "./MessageView";

export type Box = "inbox" | "archive";

/** Inbox / archive list of the address and the reading pane. */
export function MessagesPane({
  a,
  box,
  setBox,
  messages,
}: {
  a: Address;
  box: Box;
  setBox: (b: Box) => void;
  messages: UseQueryResult<MessageSummary[]>;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  // ?message=<id> (links from the Quarantine and Failed deliveries pages) opens that message.
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(params.get("message"));
  const bulk = useMutation({
    mutationFn: (b: { action: string; scope: string }) => post<{ affected: number }>(`/v1/addresses/${a.id}/messages/bulk`, b),
    onSuccess: (r) => {
      invalidate(qc, ["messages", a.id], ["address", a.id], ["addresses"]);
      toast(`${r.affected} message(s) updated`, "success");
      setSelected(null);
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <section aria-labelledby="inbox" className="grid gap-4 xl:grid-cols-5">
      <div className="xl:col-span-2">
        <h2 id="inbox" className="sr-only">
          Messages
        </h2>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label="Mailbox" className="flex gap-1">
            {(["inbox", "archive"] as const).map((b) => (
              <button
                key={b}
                role="tab"
                aria-selected={box === b}
                className={`rounded-md px-3 py-1 text-sm ${box === b ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                onClick={() => {
                  setBox(b);
                  setSelected(null);
                }}
              >
                {b === "inbox" ? "Inbox" : "Archive"}
              </button>
            ))}
          </div>
          {!!messages.data?.length && (
            <div className="flex gap-1">
              {box === "inbox" ? (
                <>
                  <button className="btn-ghost px-2 text-xs" onClick={() => bulk.mutate({ action: "read", scope: "inbox" })}>
                    Mark all read
                  </button>
                  <button className="btn-ghost px-2 text-xs" onClick={() => bulk.mutate({ action: "archive", scope: "inbox" })}>
                    Archive all
                  </button>
                </>
              ) : (
                <button
                  className="btn-ghost px-2 text-xs text-red-600"
                  onClick={() =>
                    confirmAction(`Delete the ${messages.data!.length} archived message(s)? This cannot be undone.`) &&
                    bulk.mutate({ action: "delete", scope: "archived" })
                  }
                >
                  Delete all archived
                </button>
              )}
            </div>
          )}
        </div>
        {messages.isLoading && <Spinner />}
        {messages.data?.length === 0 &&
          (box === "inbox" ? (
            <EmptyState title={a.message_count ? "Inbox empty" : "No mail yet"}>
              {a.message_count ? (
                "Archived mail is under Archive."
              ) : (
                <>
                  Use <span className="font-mono">{a.email}</span> on {a.site_name}.
                </>
              )}
            </EmptyState>
          ) : (
            <EmptyState title="Archive empty" />
          ))}
        <ul className="card max-h-[70vh] divide-y divide-zinc-200 overflow-auto dark:divide-zinc-800">
          {messages.data?.map((m) => (
            <li key={m.id}>
              <button
                className={`block w-full px-4 py-3 text-left hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100 dark:hover:bg-zinc-800/50 ${selected === m.id ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
                onClick={() => setSelected(m.id)}
                aria-current={selected === m.id}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-sm ${m.read_at ? "" : "font-semibold"}`}>{m.from_name ?? m.from}</span>
                  <span className="shrink-0 text-xs text-zinc-500">{timeAgo(m.received_at)}</span>
                </div>
                <div className={`truncate text-sm ${m.read_at ? "text-zinc-600 dark:text-zinc-400" : "font-medium"}`}>
                  {m.subject ?? "(no subject)"}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                  {m.code && (
                    <code className="rounded bg-zinc-900 px-1.5 font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                      {m.code}
                    </code>
                  )}
                  {m.forwarded && <span>↪ forwarded</span>}
                  {m.quarantined_at && (
                    <span
                      className="rounded bg-amber-100 px-1 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      title="Held by a rule: see Quarantine"
                    >
                      quarantined
                    </span>
                  )}
                  {m.attachments.some((x) => !x.inline) && (
                    <span title="Has attachments (not stored)">
                      <PaperclipIcon />
                    </span>
                  )}
                  {m.auth_warning && (
                    <span className="rounded bg-red-100 px-1 text-red-700 dark:bg-red-950 dark:text-red-300" title="Possible phishing">
                      phishing?
                    </span>
                  )}
                  {m.is_bulk && <span title="Newsletter / bulk mail">newsletter</span>}
                  <span className="truncate">{m.preview}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="card p-4 xl:col-span-3">
        {selected ? (
          <MessageView key={selected} id={selected} onGone={() => setSelected(null)} />
        ) : (
          <p className="text-sm text-zinc-500">Select a message to read it. Shortcuts: e archive, Delete delete.</p>
        )}
      </div>
    </section>
  );
}
