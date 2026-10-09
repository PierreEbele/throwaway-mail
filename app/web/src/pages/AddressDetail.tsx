import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../api";
import type { Address, CodeResult, MessageFull, MessageSummary } from "../types";
import { Badge, CopyButton, EmptyState, ErrorText, Modal, Spinner, Toggle, confirmAction, useToast } from "../components/ui";
import { useDestinations } from "./Addresses";
import { fullDate, hostOf, timeAgo } from "../util";

const IFRAME_CSP = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";

function emailDoc(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}"><base target="_blank"><style>body{margin:0;padding:12px;font-family:system-ui,sans-serif;color:#111;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

function MessageView({ id, onGone }: { id: string; onGone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = (addressId: string) => {
    qc.invalidateQueries({ queryKey: ["messages", addressId] });
    qc.invalidateQueries({ queryKey: ["message", id] });
    qc.invalidateQueries({ queryKey: ["address", addressId] });
    qc.invalidateQueries({ queryKey: ["addresses"] });
    qc.invalidateQueries({ queryKey: ["code", addressId] });
  };
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
  const msg = useQuery({ queryKey: ["message", id], queryFn: () => get<{ message: MessageFull }>(`/v1/messages/${id}`).then((r) => r.message) });
  const [mode, setMode] = useState<"html" | "text" | "headers">("html");
  const m = msg.data;
  useEffect(() => {
    if (m && !m.read_at) {
      patch(`/v1/messages/${m.id}`, { read: true }).then(() => {
        qc.invalidateQueries({ queryKey: ["messages", m.address_id] });
        qc.invalidateQueries({ queryKey: ["addresses"] });
      });
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
            <button className="btn-ghost text-red-600" onClick={() => confirmAction("Delete this message? This cannot be undone.") && remove.mutate()} title="Shortcut: Delete">
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
      {m.extracted.code && (
        <div className="flex items-center gap-3 rounded-md bg-indigo-50 p-3 dark:bg-indigo-950/40">
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
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm disabled:opacity-40 ${mode === t ? "border-indigo-600 font-medium" : "border-transparent text-zinc-500"}`}
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
      {mode === "text" && <pre className="max-h-[60vh] overflow-auto rounded-md bg-zinc-100 p-3 text-sm whitespace-pre-wrap dark:bg-zinc-800">{m.text ?? "(no text part)"}</pre>}
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

function EditSiteDialog({ address, open, onClose }: { address: Address; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [siteName, setSiteName] = useState(address.site_name);
  const [siteUrl, setSiteUrl] = useState(address.site_url ?? "");
  const [label, setLabel] = useState(address.label ?? "");
  useEffect(() => {
    if (open) {
      setSiteName(address.site_name);
      setSiteUrl(address.site_url ?? "");
      setLabel(address.label ?? "");
    }
  }, [open, address]);
  const save = useMutation({
    mutationFn: () => patch(`/v1/addresses/${address.id}`, { site_name: siteName, site_url: siteUrl, label }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["address", address.id] });
      qc.invalidateQueries({ queryKey: ["addresses"] });
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Edit site">
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <label htmlFor="es-name" className="label">Site name</label>
          <input id="es-name" className="input" required value={siteName} onChange={(e) => setSiteName(e.target.value)} autoFocus />
        </div>
        <div>
          <label htmlFor="es-url" className="label">Site URL</label>
          <input id="es-url" className="input" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="example.com" />
        </div>
        <div>
          <label htmlFor="es-label" className="label">Label / note</label>
          <input id="es-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

export function AddressDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const address = useQuery({ queryKey: ["address", id], queryFn: () => get<{ address: Address }>(`/v1/addresses/${id}`).then((r) => r.address) });
  const [box, setBox] = useState<"inbox" | "archive">("inbox");
  const messages = useQuery({
    queryKey: ["messages", id, box],
    queryFn: () => get<{ messages: MessageSummary[] }>(`/v1/addresses/${id}/messages?limit=200&archived=${box === "archive"}`).then((r) => r.messages),
  });
  const bulk = useMutation({
    mutationFn: (b: { action: string; scope: string }) => post<{ affected: number }>(`/v1/addresses/${id}/messages/bulk`, b),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["messages", id] });
      qc.invalidateQueries({ queryKey: ["address", id] });
      qc.invalidateQueries({ queryKey: ["addresses"] });
      toast(`${r.affected} message(s) updated`, "success");
      setSelected(null);
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const code = useQuery({ queryKey: ["code", id], queryFn: () => get<CodeResult | null>(`/v1/addresses/${id}/code`) });
  const dests = useDestinations();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<{ address: Address }>(`/v1/addresses/${id}`, body),
    onSuccess: (r) => {
      qc.setQueryData(["address", id], r.address);
      qc.invalidateQueries({ queryKey: ["addresses"] });
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const remove = useMutation({
    mutationFn: () => del(`/v1/addresses/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["addresses"] });
      toast("Address deleted", "success");
      nav("/");
    },
  });

  const verified = useMemo(() => (dests.data ?? []).filter((d) => d.verified), [dests.data]);
  if (address.isLoading) return <Spinner />;
  if (address.error || !address.data) return <ErrorText error={address.error ?? "Not found"} />;
  const a = address.data;
  const forwardTarget = a.destination_id ? dests.data?.find((d) => d.id === a.destination_id) : verified[0];
  const forwardWarning = a.forward_enabled && (!forwardTarget || !forwardTarget.verified);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">← All addresses</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              {a.site_name} {a.status !== "active" && <Badge value={a.status} />}
            </h1>
            {a.site_url && (
              <a href={a.site_url} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                {hostOf(a.site_url)} ↗
              </a>
            )}
            {a.label && <p className="text-sm text-zinc-500">{a.label}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded bg-zinc-100 px-2 py-1 font-mono text-base break-all dark:bg-zinc-800">{a.email}</code>
              <CopyButton text={a.email} label="Copy address" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => setEditing(true)}>Edit site</button>
            {a.status === "active" ? (
              <button className="btn-secondary" onClick={() => update.mutate({ status: "paused" })}>Pause</button>
            ) : (
              <button className="btn-secondary" onClick={() => update.mutate({ status: "active" })}>{a.status === "archived" ? "Unarchive" : "Resume"}</button>
            )}
            {a.status !== "archived" && <button className="btn-secondary" onClick={() => update.mutate({ status: "archived" })}>Archive</button>}
            <button
              className="btn-danger"
              onClick={() => confirmAction(`Delete ${a.email} and its ${a.message_count} message(s)? This cannot be undone.`) && remove.mutate()}
            >
              Delete
            </button>
          </div>
        </div>
        {a.status !== "active" && <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">This address is {a.status}: new mail is rejected.</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2" aria-labelledby="latest-code">
          <h2 id="latest-code" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Latest code</h2>
          {code.isLoading ? (
            <Spinner />
          ) : code.data?.code ? (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-4">
                <span className="font-mono text-5xl font-bold tracking-[0.2em] select-all" data-testid="latest-code">{code.data.code}</span>
                <CopyButton text={code.data.code} label="Copy code" className="btn-primary" big />
              </div>
              <p className="mt-2 text-sm text-zinc-500">
                {code.data.subject ?? "(no subject)"} · {code.data.from} · {timeAgo(code.data.received_at)} · confidence {Math.round((code.data.confidence ?? 0) * 100)}%
              </p>
              {code.data.alternatives.length > 0 && (
                <p className="mt-1 text-xs text-zinc-500">
                  Other candidates: {code.data.alternatives.map((x) => <code key={x.value} className="mx-1 rounded bg-zinc-100 px-1 dark:bg-zinc-800">{x.value}</code>)}
                </p>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">
              {code.data ? "The latest mail has no code (only links, below). Older codes are in the inbox." : "No code received yet. This card updates live when a mail arrives."}
            </p>
          )}
          {code.data && code.data.links.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Verification links</h3>
              <ul className="mt-1 space-y-1">
                {code.data.links.map((l) => (
                  <li key={l.url} className="flex items-center gap-2 text-sm">
                    <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-indigo-600 hover:underline dark:text-indigo-400" title={l.url}>
                      {l.label || l.url}
                    </a>
                    <CopyButton text={l.url} label="Copy link" className="btn-ghost px-2 py-0.5 text-xs" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="card space-y-4 p-5" aria-labelledby="forwarding">
          <h2 id="forwarding" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">Forwarding for this site</h2>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="fwd-toggle" className="text-sm">Forward new mail to my mailbox</label>
            <Toggle id="fwd-toggle" checked={a.forward_enabled} onChange={(v) => update.mutate({ forward_enabled: v })} label="Forward new mail for this site" />
          </div>
          <div>
            <label htmlFor="fwd-dest" className="label">Destination</label>
            <select id="fwd-dest" className="input" value={a.destination_id ?? ""} onChange={(e) => update.mutate({ destination_id: e.target.value || null })}>
              <option value="">Default (first verified)</option>
              {(dests.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.email}{d.verified ? "" : " (unverified)"}
                </option>
              ))}
            </select>
          </div>
          {forwardWarning && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Forwarding is on but the destination is not verified, so mail is only stored. <Link to="/destinations" className="underline">Manage destinations</Link>
            </p>
          )}
          <p className="text-xs text-zinc-500">Changes apply to the next mail received.</p>
          <dl className="grid grid-cols-2 gap-1 text-xs text-zinc-500">
            <dt>Created</dt><dd>{fullDate(a.created_at)}</dd>
            <dt>Last mail</dt><dd>{timeAgo(a.last_message_at)}</dd>
            <dt>Expires</dt><dd>{a.expires_at ? fullDate(a.expires_at) : "never"}</dd>
          </dl>
        </section>
      </div>

      <section aria-labelledby="inbox" className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <h2 id="inbox" className="sr-only">Messages</h2>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="Mailbox" className="flex gap-1">
              {(["inbox", "archive"] as const).map((b) => (
                <button
                  key={b}
                  role="tab"
                  aria-selected={box === b}
                  className={`rounded-md px-3 py-1 text-sm ${box === b ? "bg-indigo-600 text-white" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
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
                    <button className="btn-ghost px-2 text-xs" onClick={() => bulk.mutate({ action: "read", scope: "inbox" })}>Mark all read</button>
                    <button className="btn-ghost px-2 text-xs" onClick={() => bulk.mutate({ action: "archive", scope: "inbox" })}>Archive all</button>
                  </>
                ) : (
                  <button
                    className="btn-ghost px-2 text-xs text-red-600"
                    onClick={() => confirmAction(`Delete the ${messages.data!.length} archived message(s)? This cannot be undone.`) && bulk.mutate({ action: "delete", scope: "archived" })}
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
                {a.message_count ? "Archived mail is under Archive." : <>Use <span className="font-mono">{a.email}</span> on {a.site_name}.</>}
              </EmptyState>
            ) : (
              <EmptyState title="Archive empty" />
            ))}
          <ul className="card max-h-[70vh] divide-y divide-zinc-200 overflow-auto dark:divide-zinc-800">
            {messages.data?.map((m) => (
              <li key={m.id}>
                <button
                  className={`block w-full px-4 py-3 text-left hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:bg-zinc-800/50 ${selected === m.id ? "bg-indigo-50 dark:bg-indigo-950/40" : ""}`}
                  onClick={() => setSelected(m.id)}
                  aria-current={selected === m.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate text-sm ${m.read_at ? "" : "font-semibold"}`}>{m.from_name ?? m.from}</span>
                    <span className="shrink-0 text-xs text-zinc-500">{timeAgo(m.received_at)}</span>
                  </div>
                  <div className={`truncate text-sm ${m.read_at ? "text-zinc-600 dark:text-zinc-400" : "font-medium"}`}>{m.subject ?? "(no subject)"}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                    {m.code && <code className="rounded bg-indigo-100 px-1.5 font-semibold text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">{m.code}</code>}
                    {m.forwarded && <span>↪ forwarded</span>}
                    <span className="truncate">{m.preview}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-4 lg:col-span-3">
          {selected ? (
            <MessageView key={selected} id={selected} onGone={() => setSelected(null)} />
          ) : (
            <p className="text-sm text-zinc-500">Select a message to read it. Shortcuts: e archive, Delete delete.</p>
          )}
        </div>
      </section>
      <EditSiteDialog address={a} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}
