import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { del, get, patch, post } from "../../api";
import { Badge, ErrorText, Spinner, useToast } from "../../components/ui";
import { fullDate, timeAgo } from "../../util";
import { Field } from "../auth/AuthCard";
import { RecoveryCodes } from "./TwoFactorCard";
import { msg, useT } from "../../i18n";

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
  return msg().security.passkeyDefault;
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
  const t = useT().security;
  const tc = useT().common;
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
        await post("/v1/auth/passkeys", { response, name: name.trim() || t.passkeyDefault });
        return { message: t.added };
      }
      if (p.kind === "remove") {
        await del(`/v1/auth/passkeys/${p.passkey.id}`, confirmation());
        return { message: t.removed };
      }
      const r = await post<{ recovery_codes: string[] | null }>("/v1/auth/passkeys/second-factor", {
        enabled: p.enabled,
        ...confirmation(),
      });
      return {
        message: p.enabled ? t.secondOn : t.secondOff,
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
    const n = window.prompt(t.namePrompt, p.name)?.trim();
    if (n && n !== p.name) void patch(`/v1/auth/passkeys/${p.id}`, { name: n }).then(refresh);
  };

  const s = status.data;
  const supported = browserSupportsWebAuthn();
  return (
    <section className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">{t.passkeys}</h2>
      <p className="text-zinc-500">{t.passkeysHelp}</p>
      {!supported && <p className="text-amber-700 dark:text-amber-300">{t.unsupported}</p>}
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
                  {p.synced && <Badge value="synced">{t.synced}</Badge>}
                  <span className="text-xs text-zinc-500">
                    {t.addedOn(fullDate(p.created_at))} · {p.last_used_at ? t.used(timeAgo(p.last_used_at)) : t.neverUsed}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => rename(p)}>
                      {t.rename}
                    </button>
                    <button
                      className="btn-ghost px-2 py-0.5 text-xs text-red-600"
                      onClick={() => setPending({ kind: "remove", passkey: p })}
                    >
                      {t.remove}
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
            {t.askSecond}
          </label>
          {s.second_factor && <p className="text-xs text-zinc-500">{t.codesLeftShared(s.recovery_codes_left)}</p>}
          {supported && !pending && (
            <button className="btn-secondary" onClick={() => setPending({ kind: "add" })}>
              {t.add}
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
              ? t.pendingAdd
              : pending.kind === "remove"
                ? t.pendingRemove(pending.passkey.name)
                : pending.enabled
                  ? t.pendingOn
                  : t.pendingOff}
          </p>
          {pending.kind === "add" && <Field id="pk-name" label={t.name} value={name} onChange={(e) => setName(e.target.value)} />}
          <input type="text" hidden readOnly autoComplete="username" />
          <Field
            id="pk-confirm"
            label={useCode ? t.codeOrRecovery : t.yourPassword}
            type={useCode ? "text" : "password"}
            autoComplete={useCode ? "one-time-code" : "current-password"}
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <ErrorText error={run.error} />
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary" disabled={run.isPending}>
              {run.isPending ? t.waiting : t.confirm}
            </button>
            <button type="button" className="btn-ghost" onClick={done}>
              {tc.cancel}
            </button>
            <button type="button" className="text-xs text-zinc-500 underline" onClick={() => setUseCode(!useCode)}>
              {useCode ? t.confirmPassword : t.confirmCode}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
