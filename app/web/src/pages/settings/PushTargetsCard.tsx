import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../../api";
import type { NotifyKind, NotifyTarget, WebhookDelivery } from "../../types";
import { Badge, CopyButton, ErrorText, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { msg, useT } from "../../i18n";

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToBytes(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

/** Subscribes this browser to Web Push and registers it as a "webpush" notification target. */
async function subscribeThisDevice(events: string[]) {
  if (!pushSupported()) throw new Error(msg().push.unsupported);
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(msg().push.blocked);
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  const { public_key } = await get<{ public_key: string }>("/v1/push/vapid-key");
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key (keys rotated) must be replaced.
  if (sub && sub.options.applicationServerKey) {
    const current = new Uint8Array(sub.options.applicationServerKey);
    const wanted = urlBase64ToBytes(public_key);
    if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(public_key) });
  const json = sub.toJSON();
  const ua = navigator.userAgent;
  const name = /iPhone|iPad/.test(ua)
    ? "iPhone / iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Firefox/.test(ua)
        ? "Firefox"
        : /Edg\//.test(ua)
          ? "Edge"
          : /Chrome/.test(ua)
            ? "Chrome"
            : /Safari/.test(ua)
              ? "Safari"
              : msg().push.thisBrowser;
  return post("/v1/push/subscriptions", { endpoint: json.endpoint, keys: json.keys, name, events });
}

export function PushTargetsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const tr = useT().push;
  const EVENT_LABELS = tr.events;
  const KIND_HELP: Record<NotifyKind, string> = tr.kindHelp;
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
      toast(tr.added, "success");
    },
  });
  const enablePush = useMutation({
    mutationFn: () => subscribeThisDevice(["code.received", "leak.detected", "address.expiring", "address.burned"]),
    onSuccess: () => {
      refresh();
      toast(tr.enabled, "success");
    },
  });
  const test = (t: NotifyTarget) =>
    post<{ ok: boolean; error?: string }>(`/v1/notify-targets/${t.id}/test`).then((r) => {
      refresh();
      toast(r.ok ? tr.testSent : tr.failed(r.error ?? ""), r.ok ? "success" : "error");
    });
  return (
    <div className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">{tr.title}</h2>
      <p className="text-zinc-500">{tr.help}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary" onClick={() => enablePush.mutate()} disabled={enablePush.isPending}>
          {tr.enableDevice}
        </button>
        <span className="text-xs text-zinc-500">{tr.webPushHelp}</span>
      </div>
      <ErrorText error={enablePush.error} />
      {(list.data ?? []).map((t) => (
        <div key={t.id} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{t.name}</strong> <Badge value={t.kind} />
            {!t.enabled && <Badge value="paused" />}
            {t.paused_at && (
              <span className="text-xs text-red-600">
                {tr.pausedAfter(t.consecutive_failures)}{" "}
                <button className="btn-ghost px-1 py-0 text-xs" onClick={() => post(`/v1/notify-targets/${t.id}/resume`).then(refresh)}>
                  {tr.resume}
                </button>
              </span>
            )}
            <span className="ml-auto flex gap-1">
              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => test(t)}>
                {tr.test}
              </button>
              <button
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={() => patch(`/v1/notify-targets/${t.id}`, { enabled: !t.enabled }).then(refresh)}
              >
                {t.enabled ? tr.pause : tr.enable}
              </button>
              <button
                className="btn-ghost px-2 py-0.5 text-xs text-red-600"
                onClick={() => confirmAction(tr.confirmRemove(t.name)) && del(`/v1/notify-targets/${t.id}`).then(refresh)}
              >
                {tr.remove}
              </button>
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {t.events.map((e) => EVENT_LABELS[e] ?? e).join(", ")}
            {t.last_error ? (
              <span className="text-red-600">{tr.lastError(t.last_error)}</span>
            ) : t.last_ok_at ? (
              <>{tr.lastSent(timeAgo(t.last_ok_at))}</>
            ) : null}
          </p>
          {t.kind === "webhook" && <Deliveries target={t} />}
          {t.kind === "webpush" && t.url && <p className="mt-1 truncate text-xs text-zinc-500">{tr.pushService(new URL(t.url).host)}</p>}
          {t.secret && (
            <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
              {tr.secret} <code className="font-mono">{t.secret}</code> <CopyButton text={t.secret} />
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
            {tr.service}
          </label>
          <select id="nt-kind" className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as NotifyKind)}>
            <option value="ntfy">ntfy</option>
            <option value="gotify">Gotify</option>
            <option value="telegram">Telegram</option>
            <option value="webhook">Webhook</option>
          </select>
          <label className="sr-only" htmlFor="nt-name">
            {tr.name}
          </label>
          <input id="nt-name" className="input" placeholder={tr.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="text-xs text-zinc-500">{KIND_HELP[kind]}</p>
        {kind !== "telegram" && (
          <input aria-label="URL" className="input" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} required />
        )}
        {kind !== "webhook" && (
          <input
            aria-label={tr.token}
            className="input"
            type="password"
            placeholder={kind === "ntfy" ? tr.tokenOptional : tr.token}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required={kind !== "ntfy"}
          />
        )}
        {kind === "telegram" && (
          <input
            aria-label={tr.chatId}
            className="input"
            placeholder={tr.chatId}
            value={chat}
            onChange={(e) => setChat(e.target.value)}
            required
          />
        )}
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">{tr.eventsLegend}</legend>
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
          {tr.add}
        </button>
      </form>
    </div>
  );
}

/** Recent deliveries of a webhook, with their status and a resend button. */
function Deliveries({ target }: { target: NotifyTarget }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const tr = useT().push;
  const list = useQuery({
    queryKey: ["deliveries", target.id],
    enabled: open,
    queryFn: () => get<{ deliveries: WebhookDelivery[] }>(`/v1/notify-targets/${target.id}/deliveries?limit=20`).then((r) => r.deliveries),
  });
  const [shown, setShown] = useState<string | null>(null);
  const resend = (d: WebhookDelivery) =>
    post<{ ok: boolean; error?: string }>(`/v1/notify-targets/${target.id}/deliveries/${d.id}/resend`).then((r) => {
      void list.refetch();
      toast(r.ok ? tr.delivered : tr.failed(r.error ?? ""), r.ok ? "success" : "error");
    });
  return (
    <div className="mt-1 text-xs">
      <button className="btn-ghost px-1 py-0 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? tr.hideDeliveries : tr.recentDeliveries}
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-zinc-200 dark:divide-zinc-800">
          {list.data?.length === 0 && <li className="py-1 text-zinc-500">{tr.noDeliveries}</li>}
          {(list.data ?? []).map((d) => (
            <li key={d.id} className="py-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge value={d.status === "delivered" ? "active" : d.status === "failed" ? "archived" : "paused"}>
                  {tr.deliveryStatus[d.status] ?? d.status}
                </Badge>
                <span className="font-mono">{d.event_type}</span>
                <span className="text-zinc-500">
                  {timeAgo(d.created_at)} · {tr.attempts(d.attempts)}
                  {d.last_status ? ` · HTTP ${d.last_status}` : ""}
                  {d.last_error && d.status !== "delivered" ? ` · ${d.last_error}` : ""}
                  {d.next_attempt_at ? tr.nextTry(timeAgo(d.next_attempt_at)) : ""}
                </span>
                <span className="ml-auto flex gap-1">
                  <button className="btn-ghost px-1 py-0 text-xs" onClick={() => setShown(shown === d.id ? null : d.id)}>
                    {tr.payload}
                  </button>
                  <button className="btn-ghost px-1 py-0 text-xs" onClick={() => resend(d)}>
                    {tr.resend}
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
