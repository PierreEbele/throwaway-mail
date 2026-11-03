import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch } from "../../api";
import type { MessageFull } from "../../types";
import { Badge, CopyButton, ErrorText, Spinner, confirmAction, useToast } from "../../components/ui";
import { PaperclipIcon, ShieldIcon } from "../../components/icons";
import { invalidate, invalidateMessage } from "../../queries";
import { fullDate } from "../../util";
import { UnsubscribeButton } from "./UnsubscribeButton";

const IFRAME_CSP = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";

function emailDoc(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}"><base target="_blank"><style>body{margin:0;padding:12px;font-family:system-ui,sans-serif;color:#111;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function MessageView({ id, onGone }: { id: string; onGone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = (addressId: string) => invalidateMessage(qc, id, addressId);
  const archive = useMutation({
    mutationFn: (archived: boolean) => patch(`/v1/messages/${id}`, { archived }),
    onSuccess: (_r, archived) => {
      refresh(msg.data!.address_id);
      toast(archived ? "Message archived" : "Message moved back to the inbox", "success");
      onGone();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/v1/messages/${id}`),
    onSuccess: () => {
      refresh(msg.data!.address_id);
      toast("Message deleted", "success");
      onGone();
    },
  });
  const msg = useQuery({
    queryKey: ["message", id],
    queryFn: () => get<{ message: MessageFull }>(`/v1/messages/${id}`).then((r) => r.message),
  });
  const [mode, setMode] = useState<"html" | "text" | "headers">("html");
  const m = msg.data;
  useEffect(() => {
    if (m && !m.read_at) {
      patch(`/v1/messages/${m.id}`, { read: true }).then(() => invalidate(qc, ["messages", m.address_id], ["addresses"]));
    }
  }, [m, qc]);
  useEffect(() => {
    if (m && !m.html) setMode("text");
  }, [m]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (!m || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey) return;
      if (e.key === "e") archive.mutate(!m.archived_at);
      if (e.key === "Delete" && window.confirm("Delete this message? This cannot be undone.")) remove.mutate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [m, archive, remove]);
  if (msg.isLoading) return <Spinner />;
  if (msg.error || !m) return <ErrorText error={msg.error} />;
  const blocked = m.html?.includes("data-blocked-src");
  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-lg font-semibold break-words">{m.subject ?? "(no subject)"}</h3>
          <div className="flex gap-1">
            <button className="btn-secondary" onClick={() => archive.mutate(!m.archived_at)} title="Shortcut: e">
              {m.archived_at ? "Move to inbox" : "Archive"}
            </button>
            <button
              className="btn-ghost text-red-600"
              onClick={() => confirmAction("Delete this message? This cannot be undone.") && remove.mutate()}
              title="Shortcut: Delete"
            >
              Delete
            </button>
          </div>
        </div>
        <p className="text-sm text-zinc-500">
          From {m.from_name ? `${m.from_name} <${m.from}>` : m.from} · {fullDate(m.received_at)}
          {m.forwarded && <> · forwarded to {m.forward_to}</>}
        </p>
        <p className="mt-1 flex flex-wrap gap-2 text-xs">
          {(["spf", "dkim", "dmarc"] as const).map((k) => (
            <Badge key={k} value={m.auth[k] === "pass" ? "verified" : m.auth[k] ? "error" : "archived"}>
              {k.toUpperCase()}: {m.auth[k] ?? "n/a"}
            </Badge>
          ))}
        </p>
      </div>
      {m.auth_warning && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
        >
          <strong>Possible phishing.</strong>{" "}
          {m.auth_warning === "lookalike"
            ? `The sender's domain imitates the site's (${m.from}). Do not click its links or enter a password.`
            : "This mail failed sender authentication (SPF/DKIM/DMARC): the sender may be forged."}
        </div>
      )}
      {(m.trackers_removed > 0 || m.unsubscribe) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          {m.trackers_removed > 0 && (
            <span title="Tracking pixels and link tracking parameters were removed">
              <ShieldIcon /> {m.trackers_removed} tracker{m.trackers_removed > 1 ? "s" : ""} removed
            </span>
          )}
          {m.unsubscribe && <UnsubscribeButton m={m} />}
        </div>
      )}
      {m.attachments.some((x) => !x.inline) && (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label="Attachments (not stored)">
          {m.attachments
            .filter((x) => !x.inline)
            .map((x, i) => (
              <li
                key={i}
                className="rounded border border-zinc-200 px-2 py-1 dark:border-zinc-700"
                title="Attachments are not stored, only listed"
              >
                <PaperclipIcon /> {x.filename ?? "unnamed"}{" "}
                <span className="text-zinc-500">
                  · {x.mime_type} · {formatSize(x.size)}
                </span>
              </li>
            ))}
        </ul>
      )}
      {m.extracted.code && (
        <div className="flex items-center gap-3 rounded-md bg-zinc-100 p-3 dark:bg-zinc-800">
          <span className="font-mono text-2xl font-bold tracking-widest">{m.extracted.code.value}</span>
          <CopyButton text={m.extracted.code.value} />
          <span className="text-xs text-zinc-500">confidence {Math.round(m.extracted.code.confidence * 100)}%</span>
        </div>
      )}
      <div role="tablist" aria-label="Message view" className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(["html", "text", "headers"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={mode === t}
            disabled={t === "html" && !m.html}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm disabled:opacity-40 ${mode === t ? "border-zinc-900 font-medium dark:border-zinc-100" : "border-transparent text-zinc-500"}`}
            onClick={() => setMode(t)}
          >
            {t === "html" ? "HTML" : t === "text" ? "Text" : "Headers"}
          </button>
        ))}
      </div>
      {mode === "html" && m.html && (
        <>
          {blocked && <p className="text-xs text-zinc-500">Remote images are blocked for privacy.</p>}
          <iframe
            title={`Message: ${m.subject ?? ""}`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={emailDoc(m.html)}
            className="h-[60vh] w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-800"
          />
        </>
      )}
      {mode === "text" && (
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-zinc-100 p-3 text-sm whitespace-pre-wrap dark:bg-zinc-800">
          {m.text ?? "(no text part)"}
        </pre>
      )}
      {mode === "headers" && (
        <dl className="max-h-[60vh] overflow-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-800">
          {m.headers.map((h, i) => (
            <div key={i} className="break-all">
              <dt className="inline font-semibold">{h.key}: </dt>
              <dd className="inline">{h.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
