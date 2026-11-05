import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch, post } from "../../api";
import type { Domain } from "../../types";
import { ErrorText, useToast } from "../../components/ui";
import { timeAgo } from "../../util";
import { MailboxFields, mailboxDraft, mailboxPayload } from "./MailboxFields";
import { msg, useT } from "../../i18n";

/** Poll status, connection test and settings editor of an IMAP domain card. */
export function MailboxPanel({ domain }: { domain: Domain & { mailbox: NonNullable<Domain["mailbox"]> } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = domain.mailbox;
  const t = useT().domainSetup;
  const tc = useT().common;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => mailboxDraft(m));
  const done = (r: { domain: Domain }) => {
    qc.invalidateQueries({ queryKey: ["domains"] });
    toast(
      `${r.domain.name}: ${msg().common.status[r.domain.status] ?? r.domain.status}`,
      r.domain.status === "active" ? "success" : "error",
    );
  };
  const test = useMutation({ mutationFn: () => post<{ domain: Domain }>(`/v1/domains/${domain.id}/test`), onSuccess: done });
  const save = useMutation({
    mutationFn: () => patch<{ domain: Domain }>(`/v1/domains/${domain.id}`, { mailbox: mailboxPayload(draft) }),
    onSuccess: (r) => {
      setEditing(false);
      done(r);
    },
  });
  return (
    <div className="mt-2 text-sm">
      <p className="flex flex-wrap items-center gap-2 text-zinc-600 dark:text-zinc-400">
        <span>
          IMAP {m.imap_user} @ {m.imap_host} · {m.imap_folder} → {m.imap_done_folder ?? t.deleted} · SMTP {m.smtp_host ?? tc.off}
        </span>
        <button className="btn-secondary" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? t.testingShort : t.testConnection}
        </button>
        <button
          className="btn-ghost"
          onClick={() => {
            setDraft(mailboxDraft(m));
            setEditing(!editing);
          }}
        >
          {editing ? tc.cancel : t.editSettings}
        </button>
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        {t.polled(m.poll_seconds, timeAgo(m.last_poll_at), timeAgo(domain.last_ingest_at ?? null))}
      </p>
      {m.last_poll_error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t.pollFailed(m.last_poll_error)}</p>}
      <ErrorText error={test.error} />
      {editing && (
        <form
          className="mt-3 space-y-3 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <MailboxFields value={draft} onChange={setDraft} existing={m} />
          <button className="btn-primary" disabled={save.isPending}>
            {save.isPending ? t.savingTesting : t.saveTest}
          </button>
          <ErrorText error={save.error} />
        </form>
      )}
    </div>
  );
}
