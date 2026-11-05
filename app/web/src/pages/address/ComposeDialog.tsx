import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address } from "../../types";
import { ErrorText, Modal, useToast } from "../../components/ui";
import { useT } from "../../i18n";

const splitList = (v: string) =>
  v
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Writes a new mail from this address (POST /v1/addresses/:id/send). */
export function ComposeDialog({ a, open, onClose }: { a: Address; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [fromName, setFromName] = useState("");
  const t = useT().addressCards.compose;
  const tc = useT().common;
  const send = useMutation({
    mutationFn: () =>
      post<{ sent: { to: string[] } }>(`/v1/addresses/${a.id}/send`, {
        to: splitList(to),
        cc: cc ? splitList(cc) : undefined,
        subject,
        text,
        from_name: fromName || undefined,
      }),
    onSuccess: (r) => {
      toast(t.sent(r.sent.to.join(", ")), "success");
      void qc.invalidateQueries({ queryKey: ["contacts", a.id] });
      setTo("");
      setCc("");
      setSubject("");
      setText("");
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={t.title} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <p className="text-xs text-zinc-500">
          {t.sentFrom} <strong>{a.email}</strong>
          {t.help}
        </p>
        <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
          <label htmlFor="compose-name">{t.fromName}</label>
          <input
            id="compose-name"
            className="input"
            placeholder={t.fromNamePlaceholder}
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
          <label htmlFor="compose-to">{t.to}</label>
          <input
            id="compose-to"
            className="input"
            required
            placeholder="someone@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <label htmlFor="compose-cc">{t.cc}</label>
          <input id="compose-cc" className="input" placeholder={t.optional} value={cc} onChange={(e) => setCc(e.target.value)} />
          <label htmlFor="compose-subject">{t.subject}</label>
          <input id="compose-subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <label htmlFor="compose-text" className="sr-only">
          {t.message}
        </label>
        <textarea id="compose-text" className="input min-h-48" required value={text} onChange={(e) => setText(e.target.value)} />
        <ErrorText error={send.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {tc.cancel}
          </button>
          <button className="btn-primary" disabled={send.isPending}>
            {send.isPending ? t.sending : t.send}
          </button>
        </div>
      </form>
    </Modal>
  );
}
