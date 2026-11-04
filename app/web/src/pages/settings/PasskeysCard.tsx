import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { del, get, patch, post } from "../../api";
import { Badge, ErrorText, Spinner, useToast } from "../../components/ui";
import { fullDate, timeAgo } from "../../util";
import { Field } from "../auth/AuthCard";
import { RecoveryCodes } from "./TwoFactorCard";

interface Passkey {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  synced: boolean;
}
interface Status {
  passkeys: Passkey[];
  second_factor: boolean;
  recovery_codes_left: number;
}
type Pending = { kind: "add" } | { kind: "remove"; passkey: Passkey } | { kind: "second-factor"; enabled: boolean };

const defaultName = () => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone / iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
};

/** Optional passkeys of local accounts: password-less sign-in, or second factor after the password. */
export function PasskeysCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["passkeys"], queryFn: () => get<Status>("/v1/auth/passkeys") });
  const [pending, setPending] = useState<Pending | null>(null);
  const [secret, setSecret] = useState("");
  const [useCode, setUseCode] = useState(false);
  const [name, setName] = useState(defaultName);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["passkeys"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const done = () => {
    setPending(null);
    setSecret("");
    refresh();
  };
  const confirmation = () => (useCode ? { code: secret } : { password: secret });
  const run = useMutation({
    mutationFn: async (p: Pending) => {
      if (p.kind === "add") {
        const { options } = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>("/v1/auth/passkeys/options", confirmation());
        const response = await startRegistration({ optionsJSON: options });
        await post("/v1/auth/passkeys", { response, name: name.trim() || "Passkey" });
        return { message: "Passkey added" };
      }
      if (p.kind === "remove") {
        await del(`/v1/auth/passkeys/${p.passkey.id}`, confirmation());
        return { message: "Passkey removed" };
      }
      const r = await post<{ recovery_codes: string[] | null }>("/v1/auth/passkeys/second-factor", {
        enabled: p.enabled,
        ...confirmation(),
      });
      return {
        message: p.enabled ? "A passkey is now asked after your password" : "Passkey no longer asked after the password",
        codes: r.recovery_codes,
      };
    },
    onSuccess: (r) => {
      done();
      if (r.codes) setCodes(r.codes);
      toast(r.message, "success");
    },
  });
  const rename = (p: Passkey) => {
    const n = window.prompt("Passkey name", p.name)?.trim();
    if (n && n !== p.name) void patch(`/v1/auth/passkeys/${p.id}`, { name: n }).then(refresh);
  };

  const s = status.data;
  const supported = browserSupportsWebAuthn();
  return (
    <section className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">Passkeys</h2>
      <p className="text-zinc-500">
        Optional: sign in with your fingerprint, face or device PIN (or a security key) instead of your password, or ask for a passkey after
        your password instead of a code from an app.
      </p>
      {!supported && <p className="text-amber-700 dark:text-amber-300">This browser does not support passkeys.</p>}
      {status.isLoading && <Spinner />}
      <ErrorText error={status.error} />
      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
      {s && !codes && (
        <>
          {s.passkeys.length > 0 && (
            <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {s.passkeys.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 p-2">
                  <strong>{p.name}</strong>
                  {p.synced && <Badge value="synced" />}
                  <span className="text-xs text-zinc-500">
                    added {fullDate(p.created_at)} · {p.last_used_at ? `used ${timeAgo(p.last_used_at)}` : "never used"}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => rename(p)}>
                      Rename
                    </button>
                    <button
                      className="btn-ghost px-2 py-0.5 text-xs text-red-600"
                      onClick={() => setPending({ kind: "remove", passkey: p })}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.second_factor}
              disabled={!s.passkeys.length}
              onChange={(e) => setPending({ kind: "second-factor", enabled: e.target.checked })}
            />
            Ask for a passkey after my password (second factor)
          </label>
          {s.second_factor && (
            <p className="text-xs text-zinc-500">
              {s.recovery_codes_left} recovery code{s.recovery_codes_left === 1 ? "" : "s"} left (shared with the authenticator app).
            </p>
          )}
          {supported && !pending && (
            <button className="btn-secondary" onClick={() => setPending({ kind: "add" })}>
              Add a passkey
            </button>
          )}
        </>
      )}
      {pending && (
        <form
          className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            run.mutate(pending);
          }}
        >
          <p>
            {pending.kind === "add"
              ? "Name the passkey, then confirm; your browser or phone will ask to create it."
              : pending.kind === "remove"
                ? `Remove “${pending.passkey.name}”? It will no longer sign you in.`
                : pending.enabled
                  ? "Ask for a passkey after your password? Recovery codes are created if you have none."
                  : "Stop asking for a passkey after your password?"}
          </p>
          {pending.kind === "add" && <Field id="pk-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} />}
          <input type="text" hidden readOnly autoComplete="username" />
          <Field
            id="pk-confirm"
            label={useCode ? "Code from your app (or a recovery code)" : "Your password"}
            type={useCode ? "text" : "password"}
            autoComplete={useCode ? "one-time-code" : "current-password"}
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <ErrorText error={run.error} />
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary" disabled={run.isPending}>
              {run.isPending ? "Waiting…" : "Confirm"}
            </button>
            <button type="button" className="btn-ghost" onClick={done}>
              Cancel
            </button>
            <button type="button" className="text-xs text-zinc-500 underline" onClick={() => setUseCode(!useCode)}>
              {useCode ? "Confirm with my password" : "Confirm with a code"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
