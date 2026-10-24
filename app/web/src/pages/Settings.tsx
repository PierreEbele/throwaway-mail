import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../api";
import type { ApiKey, NotifyKind, NotifyTarget } from "../types";
import { useAuth } from "../auth";
import { Badge, CopyButton, EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../components/ui";
import { useDestinations, useDomains } from "./Addresses";
import { decryptJson, encryptJson, isEncrypted } from "../backupCrypto";
import { fullDate, timeAgo } from "../util";

export function DestinationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const dests = useDestinations();
  const [email, setEmail] = useState("");
  const inv = () => qc.invalidateQueries({ queryKey: ["destinations"] });
  const add = useMutation({
    mutationFn: () => post("/v1/destinations", { email }),
    onSuccess: () => {
      setEmail("");
      inv();
      toast("Cloudflare sent a verification e-mail to that address", "success");
    },
  });
  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "refresh" | "resend" | "delete" }) => (op === "delete" ? del(`/v1/destinations/${id}`) : post(`/v1/destinations/${id}/${op}`)),
    onSuccess: (_r, v) => {
      inv();
      if (v.op === "resend") toast("Verification e-mail sent again", "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <>
      <PageHeader title="Destinations" subtitle="Personal mailboxes that sites can forward to. Cloudflare must verify each one (click the link in the e-mail it sends)." />
      <form
        className="card mb-6 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="dest-email" className="label">Add a mailbox</label>
          <input id="dest-email" type="email" required className="input" placeholder="me@personal.example" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button className="btn-primary" disabled={add.isPending}>Add &amp; send verification</button>
        <div className="w-full"><ErrorText error={add.error} /></div>
      </form>
      {dests.isLoading && <Spinner />}
      {dests.data?.length === 0 && <EmptyState title="No destinations yet" />}
      {!!dests.data?.length && (
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
          {dests.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{d.email}</span>
                  <Badge value={d.verified ? "verified" : "unverified"} />
                </div>
                <p className="text-xs text-zinc-500">{d.verified ? `Verified ${timeAgo(d.verified_at)}` : "Waiting for you to click the Cloudflare verification link"}</p>
                {d.last_error && <p className="text-xs text-red-600">{d.last_error}</p>}
              </div>
              {!d.verified && (
                <>
                  <button className="btn-secondary" onClick={() => action.mutate({ id: d.id, op: "refresh" })}>Check status</button>
                  <button className="btn-secondary" onClick={() => action.mutate({ id: d.id, op: "resend" })}>Resend</button>
                </>
              )}
              <button className="btn-ghost text-red-600" onClick={() => confirmAction(`Remove ${d.email}?`) && action.mutate({ id: d.id, op: "delete" })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function KeysPage() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => get<{ keys: ApiKey[] }>("/v1/keys").then((r) => r.keys) });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ key: string }>("/v1/keys", { name }),
    onSuccess: (r) => {
      setCreated(r.key);
      setName("");
      qc.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/v1/keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["keys"] }) });
  const origin = location.origin;
  return (
    <>
      <PageHeader title="API keys" subtitle="Use a key as a Bearer token. Keys are stored hashed; the full key is shown only once." />
      <form
        className="card mb-4 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="key-name" className="label">Key name</label>
          <input id="key-name" required className="input" placeholder="e.g. signup-bot" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn-primary" disabled={create.isPending}>Create key</button>
        <div className="w-full"><ErrorText error={create.error} /></div>
      </form>
      {created && (
        <div className="card mb-6 border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40" role="alert">
          <p className="text-sm font-medium">Copy your new key now. It will not be shown again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-white px-2 py-1 font-mono text-sm break-all dark:bg-zinc-900" data-testid="new-key">{created}</code>
            <CopyButton text={created} />
            <button className="btn-ghost" onClick={() => setCreated(null)}>Done</button>
          </div>
          <pre className="mt-3 overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-100">{`curl -s -H "Authorization: Bearer ${created}" \\
  -H "Content-Type: application/json" \\
  -d '{"site_name":"Example"}' ${origin}/v1/addresses`}</pre>
        </div>
      )}
      {keys.isLoading && <Spinner />}
      {keys.data?.length === 0 && <EmptyState title="No API keys" />}
      {!!keys.data?.length && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Prefix</th><th className="px-4 py-2">Created</th><th className="px-4 py-2">Last used</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {keys.data.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                  <td className="px-4 py-2">{k.name}</td>
                  <td className="px-4 py-2 font-mono">{k.prefix}…</td>
                  <td className="px-4 py-2">{fullDate(k.created_at)}</td>
                  <td className="px-4 py-2">{timeAgo(k.last_used_at)}</td>
                  <td className="px-4 py-2 text-right">
                    {k.revoked_at ? <Badge value="archived">revoked</Badge> : (
                      <button className="btn-ghost text-red-600" onClick={() => confirmAction(`Revoke "${k.name}"? Programs using it will stop working.`) && revoke.mutate(k.id)}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function AccountPage() {
  const { user, ssoProvider } = useAuth();
  return (
    <>
      <PageHeader title="Account" />
      <div className="card max-w-xl space-y-2 p-5 text-sm">
        <p>
          Signed in as <strong>{user?.name ?? user?.email}</strong> ({user?.email}) <Badge value={user?.role ?? "user"} />
        </p>
        <p className="text-zinc-500">Member since {fullDate(user?.created_at)} · last sign-in {fullDate(user?.last_login_at)}</p>
        <p className="text-zinc-500">
          Your identity, password and two-factor settings are managed by {ssoProvider}. Your role here follows your {ssoProvider} groups and is
          refreshed at every sign-in.
        </p>
      </div>
      <NotificationsCard />
      <PushTargetsCard />
      <DirectoriesCard />
      <PanicCard />
      <BackupCard />
    </>
  );
}

export const NOTIFY_KEY = "notify-new-mail";

function NotificationsCard() {
  const supported = typeof Notification !== "undefined";
  const [on, setOn] = useState(supported && localStorage.getItem(NOTIFY_KEY) === "1" && Notification.permission === "granted");
  const toggle = async () => {
    if (on) {
      localStorage.removeItem(NOTIFY_KEY);
      setOn(false);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem(NOTIFY_KEY, "1");
      setOn(true);
    }
  };
  return (
    <div className="card mt-4 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">Desktop notifications</h2>
      {supported ? (
        <>
          <p className="text-zinc-500">
            Get a system notification when a mail arrives while this app is open in a tab (even in the background). Mails with a verification code show the code; click the
            notification to copy it.
          </p>
          <button className={on ? "btn-secondary" : "btn-primary"} onClick={toggle}>{on ? "Turn off" : "Turn on"}</button>
          {Notification.permission === "denied" && <p className="text-amber-700 dark:text-amber-400">Notifications are blocked for this site in your browser settings.</p>}
        </>
      ) : (
        <p className="text-zinc-500">This browser does not support notifications.</p>
      )}
    </div>
  );
}

function BackupCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [result, setResult] = useState<string | null>(null);
  const exportEncrypted = async () => {
    const pass = window.prompt("Passphrase for the export (at least 8 characters, keep it safe: it cannot be recovered)");
    if (!pass) return;
    if (pass.length < 8) return toast("Passphrase too short", "error");
    if (window.prompt("Type the passphrase again") !== pass) return toast("Passphrases do not match", "error");
    try {
      const file = await encryptJson(await get("/v1/export"), pass);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "throwaway-mail-export.encrypted.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const importFile = async (file: File) => {
    try {
      let data = JSON.parse(await file.text());
      if (isEncrypted(data)) {
        const pass = window.prompt("This export is encrypted. Passphrase:");
        if (!pass) return;
        data = await decryptJson<{ categories?: unknown[]; addresses?: unknown[] }>(data, pass);
      }
      const r = await post<{ categories_created: number; addresses_created: number; skipped: Array<{ email: string; reason: string }> }>("/v1/import", {
        categories: data.categories ?? [],
        addresses: data.addresses ?? [],
      });
      qc.invalidateQueries();
      setResult(
        `${r.addresses_created} address(es) and ${r.categories_created} categor${r.categories_created === 1 ? "y" : "ies"} imported` +
          (r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map((x) => x.reason))].join(", ")})` : ""),
      );
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="card mt-4 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">Export / import</h2>
      <p className="text-zinc-500">
        Download your addresses and categories as JSON (mails are not included), optionally encrypted with a passphrase in your browser (AES-256-GCM), or import such a file. Addresses must be on a domain configured here; existing ones are
        skipped.
      </p>
      <div className="flex flex-wrap gap-2">
        <a className="btn-secondary" href="/v1/export" download>Export JSON</a>
        <button className="btn-secondary" onClick={exportEncrypted}>Export encrypted…</button>
        <label className="btn-secondary cursor-pointer">
          Import JSON…
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0]).finally(() => (e.target.value = ""))} />
        </label>
      </div>
      {result && <p role="status">{result}</p>}
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = {
  "code.received": "Verification codes",
  "message.received": "Every mail",
  "leak.detected": "Possible leaks",
  "address.expiring": "Address about to expire",
  "address.burned": "Address burned automatically",
};

const KIND_HELP: Record<NotifyKind, string> = {
  ntfy: "Full topic URL, e.g. https://ntfy.sh/my-secret-topic. Token optional (access token).",
  gotify: "Server URL and an application token.",
  telegram: "Bot token from @BotFather and your chat id.",
  webhook: "Any URL (n8n, Home Assistant, Zapier...). JSON body signed with HMAC-SHA256 (x-tm-signature).",
};

function PushTargetsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["notify-targets"], queryFn: () => get<{ targets: NotifyTarget[] }>("/v1/notify-targets").then((r) => r.targets) });
  const [kind, setKind] = useState<NotifyKind>("ntfy");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [chat, setChat] = useState("");
  const [events, setEvents] = useState<string[]>(["code.received", "leak.detected", "address.expiring", "address.burned"]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["notify-targets"] });
  const add = useMutation({
    mutationFn: () => post("/v1/notify-targets", { kind, name: name || kind, url: url || undefined, token: token || undefined, chat_id: chat || undefined, events }),
    onSuccess: () => { refresh(); setName(""); setUrl(""); setToken(""); setChat(""); toast("Target added", "success"); },
  });
  const test = (t: NotifyTarget) =>
    post<{ ok: boolean; error?: string }>(`/v1/notify-targets/${t.id}/test`).then((r) => { refresh(); toast(r.ok ? "Test sent" : `Failed: ${r.error}`, r.ok ? "success" : "error"); });
  return (
    <div className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">Push notifications &amp; webhooks</h2>
      <p className="text-zinc-500">Works even when the app is closed: get codes and leak alerts on your phone (ntfy, Gotify, Telegram) or feed automations.</p>
      {(list.data ?? []).map((t) => (
        <div key={t.id} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{t.name}</strong> <Badge value={t.kind} />
            {!t.enabled && <Badge value="paused" />}
            <span className="ml-auto flex gap-1">
              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => test(t)}>Test</button>
              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => patch(`/v1/notify-targets/${t.id}`, { enabled: !t.enabled }).then(refresh)}>{t.enabled ? "Pause" : "Enable"}</button>
              <button className="btn-ghost px-2 py-0.5 text-xs text-red-600" onClick={() => confirmAction(`Remove ${t.name}?`) && del(`/v1/notify-targets/${t.id}`).then(refresh)}>Remove</button>
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {t.events.map((e) => EVENT_LABELS[e] ?? e).join(", ")}
            {t.last_error ? <span className="text-red-600"> · last error: {t.last_error}</span> : t.last_ok_at ? <> · last sent {timeAgo(t.last_ok_at)}</> : null}
          </p>
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
          <label className="sr-only" htmlFor="nt-kind">Service</label>
          <select id="nt-kind" className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as NotifyKind)}>
            <option value="ntfy">ntfy</option>
            <option value="gotify">Gotify</option>
            <option value="telegram">Telegram</option>
            <option value="webhook">Webhook</option>
          </select>
          <label className="sr-only" htmlFor="nt-name">Name</label>
          <input id="nt-name" className="input" placeholder="Name (e.g. My phone)" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="text-xs text-zinc-500">{KIND_HELP[kind]}</p>
        {kind !== "telegram" && <input aria-label="URL" className="input" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} required />}
        {kind !== "webhook" && <input aria-label="Token" className="input" type="password" placeholder={kind === "ntfy" ? "Token (optional)" : "Token"} value={token} onChange={(e) => setToken(e.target.value)} required={kind !== "ntfy"} />}
        {kind === "telegram" && <input aria-label="Chat id" className="input" placeholder="Chat id" value={chat} onChange={(e) => setChat(e.target.value)} required />}
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">Events</legend>
          {Object.entries(EVENT_LABELS).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={events.includes(k)} onChange={(e) => setEvents(e.target.checked ? [...events, k] : events.filter((x) => x !== k))} /> {label}
            </label>
          ))}
        </fieldset>
        <ErrorText error={add.error} />
        <button className="btn-primary" disabled={add.isPending || !events.length}>Add</button>
      </form>
    </div>
  );
}

function PanicCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const run = (action: "pause" | "undo") =>
    post<{ affected: number }>("/v1/panic", { action }).then(
      (r) => { qc.invalidateQueries(); toast(action === "pause" ? `${r.affected} address(es) paused` : `${r.affected} address(es) resumed`, "success"); },
      (e: Error) => toast(e.message, "error"),
    );
  return (
    <div className="card mt-4 max-w-xl space-y-2 border-red-200 p-5 text-sm dark:border-red-900/50">
      <h2 className="font-semibold">Panic button</h2>
      <p className="text-zinc-500">Pause every active address at once (all mail rejected), e.g. after a breach. Undo resumes exactly the addresses it paused.</p>
      <div className="flex gap-2">
        <button className="btn-danger" onClick={() => confirmAction("Pause ALL your active addresses now?") && run("pause")}>Pause everything</button>
        <button className="btn-secondary" onClick={() => run("undo")}>Undo</button>
      </div>
    </div>
  );
}

function DirectoriesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const list = useQuery({ queryKey: ["directories"], queryFn: () => get<{ directories: Array<{ id: string; name: string }> }>("/v1/directories").then((r) => r.directories) });
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => post("/v1/directories", { name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["directories"] }); setName(""); toast("Directory reserved", "success"); },
  });
  const domain = domains.data?.find((d) => d.status === "active")?.name ?? "your-domain";
  return (
    <div className="card mt-4 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">On-the-fly addresses</h2>
      <p className="text-zinc-500">
        Reserve a name, then give out <code className="font-mono">{list.data?.[0]?.name ?? "name"}.anysite@{domain}</code> anywhere, even from a phone or a paper form: the
        address is created when its first mail arrives (sorted with your category keywords).
      </p>
      {(list.data ?? []).map((x) => (
        <div key={x.id} className="flex items-center gap-2">
          <code className="font-mono">{x.name}.*@{domain}</code>
          <button className="btn-ghost ml-auto px-2 py-0.5 text-xs text-red-600" onClick={() => confirmAction(`Release ${x.name}? Existing addresses are kept.`) && del(`/v1/directories/${x.id}`).then(() => qc.invalidateQueries({ queryKey: ["directories"] }))}>
            Release
          </button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label className="sr-only" htmlFor="dir-name">Directory name</label>
        <input id="dir-name" className="input" placeholder="e.g. dory" pattern="[a-z0-9]{3,32}" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} required />
        <button className="btn-primary shrink-0" disabled={add.isPending}>Reserve</button>
      </form>
      <ErrorText error={add.error} />
    </div>
  );
}
