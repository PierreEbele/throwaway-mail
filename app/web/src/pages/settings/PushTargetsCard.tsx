import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../../api";
import type { NotifyKind, NotifyTarget, WebhookDelivery } from "../../types";
import { Badge, CopyButton, ErrorText, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";

const EVENT_LABELS: Record<string, string> = {
  "code.received": "Verification codes",
  "message.received": "Every mail",
  "leak.detected": "Possible leaks",
  "address.expiring": "Address about to expire",
  "address.burned": "Address burned automatically",
  "system.alert": "Instance alerts: failed backup or probe (admins only)",
  "address.created": "Address created",
  "address.deleted": "Address deleted",
  "address.expired": "Address expired",
  "message.blocked": "Mail blocked",
  "message.sent": "Mail sent from an alias",
  "forward.failed": "Forward failed",
};

const KIND_HELP: Record<NotifyKind, string> = {
  ntfy: "Full topic URL, e.g. https://ntfy.sh/my-secret-topic. Token optional (access token).",
  gotify: "Server URL and an application token.",
  telegram: "Bot token from @BotFather and your chat id.",
  webhook: "Any URL (n8n, Home Assistant, Zapier...). JSON body signed with HMAC-SHA256 (x-tm-signature).",
};

export function PushTargetsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ["notify-targets"],
    queryFn: () => get<{ targets: NotifyTarget[] }>("/v1/notify-targets").then((r) => r.targets),
  });
  const [kind, setKind] = useState<NotifyKind>("ntfy");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [chat, setChat] = useState("");
  const [events, setEvents] = useState<string[]>(["code.received", "leak.detected", "address.expiring", "address.burned"]);
  const refresh = () => invalidate(qc, ["notify-targets"]);
  const add = useMutation({
    mutationFn: () =>
      post("/v1/notify-targets", {
        kind,
        name: name || kind,
        url: url || undefined,
        token: token || undefined,
        chat_id: chat || undefined,
        events,
      }),
    onSuccess: () => {
      refresh();
      setName("");
      setUrl("");
      setToken("");
      setChat("");
      toast("Target added", "success");
    },
  });
  const test = (t: NotifyTarget) =>
    post<{ ok: boolean; error?: string }>(`/v1/notify-targets/${t.id}/test`).then((r) => {
      refresh();
      toast(r.ok ? "Test sent" : `Failed: ${r.error}`, r.ok ? "success" : "error");
    });
  return (
    <div className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">Push notifications &amp; webhooks</h2>
      <p className="text-zinc-500">
        Works even when the app is closed: get codes and leak alerts on your phone (ntfy, Gotify, Telegram) or feed automations.
      </p>
      {(list.data ?? []).map((t) => (
        <div key={t.id} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{t.name}</strong> <Badge value={t.kind} />
            {!t.enabled && <Badge value="paused" />}
            {t.paused_at && (
              <span className="text-xs text-red-600">
                paused after {t.consecutive_failures} failed deliveries{" "}
                <button className="btn-ghost px-1 py-0 text-xs" onClick={() => post(`/v1/notify-targets/${t.id}/resume`).then(refresh)}>
                  Resume
                </button>
              </span>
            )}
            <span className="ml-auto flex gap-1">
              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => test(t)}>
                Test
              </button>
              <button
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={() => patch(`/v1/notify-targets/${t.id}`, { enabled: !t.enabled }).then(refresh)}
              >
                {t.enabled ? "Pause" : "Enable"}
              </button>
              <button
                className="btn-ghost px-2 py-0.5 text-xs text-red-600"
                onClick={() => confirmAction(`Remove ${t.name}?`) && del(`/v1/notify-targets/${t.id}`).then(refresh)}
              >
                Remove
              </button>
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {t.events.map((e) => EVENT_LABELS[e] ?? e).join(", ")}
            {t.last_error ? (
              <span className="text-red-600"> · last error: {t.last_error}</span>
            ) : t.last_ok_at ? (
              <> · last sent {timeAgo(t.last_ok_at)}</>
            ) : null}
          </p>
          {t.kind === "webhook" && <Deliveries target={t} />}
          {t.secret && (
            <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
              Signing secret: <code className="font-mono">{t.secret}</code> <CopyButton text={t.secret} />
            </p>
          )}
        </div>
      ))}
      <form
        className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="nt-kind">
            Service
          </label>
          <select id="nt-kind" className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as NotifyKind)}>
            <option value="ntfy">ntfy</option>
            <option value="gotify">Gotify</option>
            <option value="telegram">Telegram</option>
            <option value="webhook">Webhook</option>
          </select>
          <label className="sr-only" htmlFor="nt-name">
            Name
          </label>
          <input id="nt-name" className="input" placeholder="Name (e.g. My phone)" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="text-xs text-zinc-500">{KIND_HELP[kind]}</p>
        {kind !== "telegram" && (
          <input aria-label="URL" className="input" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} required />
        )}
        {kind !== "webhook" && (
          <input
            aria-label="Token"
            className="input"
            type="password"
            placeholder={kind === "ntfy" ? "Token (optional)" : "Token"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required={kind !== "ntfy"}
          />
        )}
        {kind === "telegram" && (
          <input
            aria-label="Chat id"
            className="input"
            placeholder="Chat id"
            value={chat}
            onChange={(e) => setChat(e.target.value)}
            required
          />
        )}
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">Events</legend>
          {Object.entries(EVENT_LABELS).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={events.includes(k)}
                onChange={(e) => setEvents(e.target.checked ? [...events, k] : events.filter((x) => x !== k))}
              />{" "}
              {label}
            </label>
          ))}
        </fieldset>
        <ErrorText error={add.error} />
        <button className="btn-primary" disabled={add.isPending || !events.length}>
          Add
        </button>
      </form>
    </div>
  );
}

/** Recent deliveries of a webhook, with their status and a resend button. */
function Deliveries({ target }: { target: NotifyTarget }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ["deliveries", target.id],
    enabled: open,
    queryFn: () => get<{ deliveries: WebhookDelivery[] }>(`/v1/notify-targets/${target.id}/deliveries?limit=20`).then((r) => r.deliveries),
  });
  const [shown, setShown] = useState<string | null>(null);
  const resend = (d: WebhookDelivery) =>
    post<{ ok: boolean; error?: string }>(`/v1/notify-targets/${target.id}/deliveries/${d.id}/resend`).then((r) => {
      void list.refetch();
      toast(r.ok ? "Delivered" : `Failed: ${r.error}`, r.ok ? "success" : "error");
    });
  return (
    <div className="mt-1 text-xs">
      <button className="btn-ghost px-1 py-0 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide deliveries" : "Recent deliveries"}
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-zinc-200 dark:divide-zinc-800">
          {list.data?.length === 0 && <li className="py-1 text-zinc-500">No deliveries yet.</li>}
          {(list.data ?? []).map((d) => (
            <li key={d.id} className="py-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge value={d.status === "delivered" ? "active" : d.status === "failed" ? "archived" : "paused"}>{d.status}</Badge>
                <span className="font-mono">{d.event_type}</span>
                <span className="text-zinc-500">
                  {timeAgo(d.created_at)} · {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                  {d.last_status ? ` · HTTP ${d.last_status}` : ""}
                  {d.last_error && d.status !== "delivered" ? ` · ${d.last_error}` : ""}
                  {d.next_attempt_at ? ` · next try ${timeAgo(d.next_attempt_at)}` : ""}
                </span>
                <span className="ml-auto flex gap-1">
                  <button className="btn-ghost px-1 py-0 text-xs" onClick={() => setShown(shown === d.id ? null : d.id)}>
                    Payload
                  </button>
                  <button className="btn-ghost px-1 py-0 text-xs" onClick={() => resend(d)}>
                    Resend
                  </button>
                </span>
              </div>
              {shown === d.id && (
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-zinc-900 p-2 text-[11px] text-zinc-100">
                  {JSON.stringify(d.payload, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
