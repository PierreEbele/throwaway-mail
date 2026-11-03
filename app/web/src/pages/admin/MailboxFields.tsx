import type { Mailbox } from "../../types";

/** Mailbox settings as edited in the form (sent as `mailbox` to POST / PATCH /v1/domains). */
export interface MailboxDraft {
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_user: string;
  imap_password: string;
  imap_folder: string;
  imap_done_folder: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: "tls" | "starttls" | "none";
  smtp_user: string;
  smtp_password: string;
  smtp_from: string;
  poll_seconds: number;
}

export function mailboxDraft(m?: Mailbox): MailboxDraft {
  return {
    imap_host: m?.imap_host ?? "",
    imap_port: m?.imap_port ?? 993,
    imap_tls: m?.imap_tls ?? true,
    imap_user: m?.imap_user ?? "",
    imap_password: "",
    imap_folder: m?.imap_folder ?? "INBOX",
    imap_done_folder: m ? (m.imap_done_folder ?? "") : "Processed",
    smtp_host: m?.smtp_host ?? "",
    smtp_port: m?.smtp_port ?? 465,
    smtp_security: m?.smtp_security ?? "tls",
    smtp_user: m?.smtp_user ?? "",
    smtp_password: "",
    smtp_from: m?.smtp_from ?? "",
    poll_seconds: m?.poll_seconds ?? 60,
  };
}

/** Request body: empty optional fields become null, empty passwords are left out (= keep the stored one). */
export function mailboxPayload(d: MailboxDraft) {
  return {
    ...d,
    imap_password: d.imap_password || undefined,
    imap_done_folder: d.imap_done_folder || null,
    smtp_host: d.smtp_host || null,
    smtp_user: d.smtp_user || null,
    smtp_password: d.smtp_password || undefined,
    smtp_from: d.smtp_from || null,
  };
}

export function MailboxFields({
  value,
  onChange,
  existing,
}: {
  value: MailboxDraft;
  onChange: (v: MailboxDraft) => void;
  /** Stored settings when editing: password fields may stay empty. */
  existing?: Mailbox;
}) {
  const set = <K extends keyof MailboxDraft>(k: K, v: MailboxDraft[K]) => onChange({ ...value, [k]: v });
  const text = (k: keyof MailboxDraft, label: string, opts: { type?: string; placeholder?: string; required?: boolean } = {}) => (
    <div>
      <label htmlFor={`mb-${k}`} className="label">
        {label}
      </label>
      <input
        id={`mb-${k}`}
        className="input"
        type={opts.type ?? "text"}
        required={opts.required}
        placeholder={opts.placeholder}
        autoComplete={opts.type === "password" ? "new-password" : "off"}
        value={String(value[k])}
        onChange={(e) => set(k, (opts.type === "number" ? Number(e.target.value) : e.target.value) as never)}
      />
    </div>
  );
  return (
    <div className="space-y-4">
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-2 text-sm font-medium">IMAP (incoming, catch-all mailbox)</legend>
        <div className="sm:col-span-2">{text("imap_host", "Server", { placeholder: "imap.provider.example", required: true })}</div>
        {text("imap_port", "Port", { type: "number" })}
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={value.imap_tls} onChange={(e) => set("imap_tls", e.target.checked)} /> TLS
        </label>
        <div className="sm:col-span-2">{text("imap_user", "Login", { required: true })}</div>
        <div className="sm:col-span-2">
          {text("imap_password", existing?.has_imap_password ? "Password (empty = keep)" : "Password (app password)", {
            type: "password",
            required: !existing?.has_imap_password,
          })}
        </div>
        <div className="sm:col-span-2">{text("imap_folder", "Folder to watch")}</div>
        <div className="sm:col-span-2">{text("imap_done_folder", "Move processed mail to (empty = delete)")}</div>
        {text("poll_seconds", "Poll every (seconds, min 15)", { type: "number" })}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-2 text-sm font-medium">SMTP (outgoing: forwarding and verification mail; optional)</legend>
        <div className="sm:col-span-2">{text("smtp_host", "Server", { placeholder: "smtp.provider.example" })}</div>
        {text("smtp_port", "Port", { type: "number" })}
        <div>
          <label htmlFor="mb-smtp_security" className="label">
            Security
          </label>
          <select
            id="mb-smtp_security"
            className="input"
            value={value.smtp_security}
            onChange={(e) => set("smtp_security", e.target.value as MailboxDraft["smtp_security"])}
          >
            <option value="tls">TLS (465)</option>
            <option value="starttls">STARTTLS (587)</option>
            <option value="none">none</option>
          </select>
        </div>
        <div className="sm:col-span-2">{text("smtp_user", "Login (empty = IMAP login)")}</div>
        <div className="sm:col-span-2">
          {text("smtp_password", existing?.has_smtp_password ? "Password (empty = keep)" : "Password (empty = IMAP password)", {
            type: "password",
          })}
        </div>
        <div className="sm:col-span-2">{text("smtp_from", "Sender address (empty = the alias)", { type: "email" })}</div>
      </fieldset>
    </div>
  );
}
