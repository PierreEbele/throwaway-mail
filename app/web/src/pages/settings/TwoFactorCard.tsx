import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { renderSVG } from "uqr";
import { get, post } from "../../api";
import { CopyButton, ErrorText, Spinner, useToast } from "../../components/ui";
import { fullDate } from "../../util";
import { Field } from "../auth/AuthCard";

interface Status {
  enabled: boolean;
  enabled_at: number | null;
  pending: boolean;
  recovery_codes_left: number;
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="space-y-3">
      <p>
        Save these recovery codes somewhere safe (a password manager). Each one signs you in once if you lose your authenticator. They are
        not shown again.
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded-md bg-zinc-100 p-3 font-mono dark:bg-zinc-900">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <CopyButton text={codes.join("\n")} label="Copy codes" />
        <button className="btn-primary" onClick={onDone}>
          I saved them
        </button>
      </div>
    </div>
  );
}

/** Password or code confirmation for turning 2FA off or replacing recovery codes. */
function ConfirmForm({
  action,
  label,
  onDone,
}: {
  action: "disable" | "recovery-codes";
  label: string;
  onDone: (codes?: string[]) => void;
}) {
  const [value, setValue] = useState("");
  const [useCode, setUseCode] = useState(false);
  const m = useMutation({
    mutationFn: () => post<{ recovery_codes?: string[] }>(`/v1/auth/2fa/${action}`, useCode ? { code: value } : { password: value }),
    onSuccess: (r) => onDone(r.recovery_codes),
  });
  return (
    <form
      className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field
        id={`2fa-confirm-${action}`}
        label={useCode ? "Code from your app (or a recovery code)" : "Your password"}
        type={useCode ? "text" : "password"}
        autoComplete={useCode ? "one-time-code" : "current-password"}
        required
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <ErrorText error={m.error} />
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={m.isPending}>
          {label}
        </button>
        <button
          type="button"
          className="text-xs text-zinc-500 underline"
          onClick={() => {
            setUseCode(!useCode);
            setValue("");
          }}
        >
          {useCode ? "Confirm with my password" : "Confirm with a code"}
        </button>
      </div>
    </form>
  );
}

/** Optional TOTP second factor for local accounts. */
export function TwoFactorCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["2fa"], queryFn: () => get<Status>("/v1/auth/2fa") });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState<"disable" | "recovery-codes" | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["2fa"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const setup = useMutation({
    mutationFn: () => post<{ secret: string; otpauth_uri: string }>("/v1/auth/2fa/setup", { password }),
    onSuccess: (r) => {
      setPassword("");
      setEnrolment(r);
    },
  });
  const enable = useMutation({
    mutationFn: () => post<{ recovery_codes: string[] }>("/v1/auth/2fa/enable", { code }),
    onSuccess: (r) => {
      setEnrolment(null);
      setCode("");
      setCodes(r.recovery_codes);
      refresh();
    },
  });

  const s = status.data;
  return (
    <section className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">Two-factor authentication</h2>
      {status.isLoading && <Spinner />}
      <ErrorText error={status.error} />
      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : s?.enabled ? (
        <>
          <p>
            On since {fullDate(s.enabled_at)}: signing in asks for a code from your authenticator app.{" "}
            <span className={s.recovery_codes_left < 3 ? "text-amber-700 dark:text-amber-300" : "text-zinc-500"}>
              {s.recovery_codes_left} recovery code{s.recovery_codes_left === 1 ? "" : "s"} left.
            </span>
          </p>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setConfirming(confirming === "recovery-codes" ? null : "recovery-codes")}>
              New recovery codes
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(confirming === "disable" ? null : "disable")}>
              Turn off
            </button>
          </div>
          {confirming && (
            <ConfirmForm
              key={confirming}
              action={confirming}
              label={confirming === "disable" ? "Turn off two-factor authentication" : "Replace recovery codes"}
              onDone={(newCodes) => {
                setConfirming(null);
                if (newCodes) setCodes(newCodes);
                else toast("Two-factor authentication is off", "success");
                refresh();
              }}
            />
          )}
        </>
      ) : enrolment ? (
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <p>Scan this QR code with an authenticator app (Aegis, 2FAS, Google Authenticator, a password manager…).</p>
          <img
            className="h-48 w-48 rounded-md bg-white p-2"
            alt="QR code for your authenticator app"
            src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(enrolment.otpauth_uri))}`}
          />
          <p className="text-xs text-zinc-500">
            Or enter this key by hand: <code className="font-mono break-all">{enrolment.secret}</code>{" "}
            <CopyButton text={enrolment.secret} label="Copy" />
          </p>
          <Field
            id="2fa-enable-code"
            label="Code shown by the app"
            autoComplete="one-time-code"
            inputMode="numeric"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <ErrorText error={enable.error} />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={enable.isPending}>
              Turn on
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEnrolment(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        s && (
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setup.mutate();
            }}
          >
            <p className="text-zinc-500">
              Optional: ask for a code from an authenticator app after your password. Confirm your password to start.
            </p>
            <input type="text" hidden readOnly autoComplete="username" />
            <Field
              id="2fa-setup-password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <ErrorText error={setup.error} />
            <button className="btn-primary" disabled={setup.isPending}>
              Set up two-factor authentication
            </button>
          </form>
        )
      )}
    </section>
  );
}
