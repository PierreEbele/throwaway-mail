import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ApiError, post } from "../../api";
import { useAuth } from "../../auth";
import { AuthCard, Field, useAfterSignIn, useT } from "./AuthCard";

type LoginResult = { two_factor_required?: boolean; challenge?: string; methods?: string[] };
type Options = { options: PublicKeyCredentialRequestOptionsJSON };

/** A cancelled or timed-out browser prompt is not worth an error message. */
const cancelled = (e: unknown) => e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");

/** Usernameless sign-in with a passkey (no e-mail, no password, no second step). */
function PasskeyButton({ returnTo }: { returnTo: string }) {
  const afterSignIn = useAfterSignIn();
  const t = useT().auth;
  const m = useMutation({
    mutationFn: async () => {
      const { options } = await post<Options>("/v1/auth/passkey/options");
      const response = await startAuthentication({ optionsJSON: options });
      return post("/v1/auth/passkey/login", { response });
    },
    onSuccess: () => afterSignIn(returnTo),
  });
  if (!browserSupportsWebAuthn()) return null;
  return (
    <div className="mt-3 space-y-2">
      {m.error && !cancelled(m.error) && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {m.error.message}
        </p>
      )}
      <button type="button" className="btn-secondary w-full py-2 text-base" onClick={() => m.mutate()} disabled={m.isPending}>
        {m.isPending ? t.waitingPasskey : t.signInPasskey}
      </button>
    </div>
  );
}

/** Second step for accounts with two-factor authentication: a code from the app, a passkey or a recovery code. */
function CodeForm({
  challenge,
  methods,
  returnTo,
  onRestart,
}: {
  challenge: string;
  methods: string[];
  returnTo: string;
  onRestart: () => void;
}) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(!methods.includes("totp"));
  const t = useT().auth;
  const afterSignIn = useAfterSignIn();
  const passkey = useMutation({
    mutationFn: async () => {
      const { options } = await post<Options>("/v1/auth/login/passkey/options", { challenge });
      const response = await startAuthentication({ optionsJSON: options });
      return post("/v1/auth/login/passkey", { challenge, response });
    },
    onSuccess: () => afterSignIn(returnTo),
  });
  const canPasskey = methods.includes("passkey") && browserSupportsWebAuthn();
  const verify = useMutation({
    mutationFn: () => post("/v1/auth/login/2fa", { challenge, code }),
    onSuccess: () => afterSignIn(returnTo),
  });
  const expired = [verify.error, passkey.error].some((e) => e instanceof ApiError && e.code === "challenge_expired");
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        verify.mutate();
      }}
    >
      {canPasskey && (
        <>
          <button type="button" className="btn-primary w-full py-2 text-base" onClick={() => passkey.mutate()} disabled={passkey.isPending}>
            {passkey.isPending ? t.waitingPasskey : t.usePasskey}
          </button>
          {passkey.error && !cancelled(passkey.error) && (
            <p className="text-sm text-red-700 dark:text-red-300" role="alert">
              {passkey.error.message}
            </p>
          )}
          <p className="text-center text-xs text-zinc-500">{t.or}</p>
        </>
      )}
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{recovery ? t.enterRecovery : t.enterTotp}</p>
      {verify.error && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {verify.error.message}
        </p>
      )}
      <Field
        key={recovery ? "recovery" : "totp"}
        id="login-code"
        label={recovery ? t.recoveryCode : t.code}
        autoComplete="one-time-code"
        inputMode={recovery ? "text" : "numeric"}
        pattern={recovery ? undefined : "[0-9 ]{6,7}"}
        required
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      {expired ? (
        <button type="button" className="btn-primary w-full py-2 text-base" onClick={onRestart}>
          {t.startAgain}
        </button>
      ) : (
        <button className="btn-primary w-full py-2 text-base" disabled={verify.isPending}>
          {verify.isPending ? t.checking : t.verify}
        </button>
      )}
      <div className="flex justify-between text-xs">
        {methods.includes("totp") ? (
          <button
            type="button"
            className="text-zinc-500 underline"
            onClick={() => {
              setRecovery(!recovery);
              setCode("");
            }}
          >
            {recovery ? t.useApp : t.useRecovery}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="text-zinc-500 underline" onClick={onRestart}>
          {t.back}
        </button>
      </div>
    </form>
  );
}

function PasswordForm({ returnTo, autoFocus }: { returnTo: string; autoFocus: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<{ token: string; methods: string[] } | null>(null);
  const t = useT().auth;
  const afterSignIn = useAfterSignIn();
  const login = useMutation({
    mutationFn: () => post<LoginResult>("/v1/auth/login", { email, password }),
    onSuccess: (r) => {
      if (r.two_factor_required && r.challenge) {
        setPassword("");
        setChallenge({ token: r.challenge, methods: r.methods ?? ["totp", "recovery"] });
      } else void afterSignIn(returnTo);
    },
  });
  if (challenge)
    return (
      <CodeForm
        challenge={challenge.token}
        methods={challenge.methods}
        returnTo={returnTo}
        onRestart={() => {
          setChallenge(null);
          login.reset();
        }}
      />
    );
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        login.mutate();
      }}
    >
      {login.error && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {login.error.message}
        </p>
      )}
      <Field
        id="login-email"
        label={t.email}
        type="email"
        autoComplete="username"
        required
        autoFocus={autoFocus}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Field
        id="login-password"
        label={t.password}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn-primary w-full py-2 text-base" disabled={login.isPending}>
        {login.isPending ? t.signingIn : t.signIn}
      </button>
    </form>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const { ssoProvider, ssoEnabled, localEnabled, setupRequired, demo } = useAuth();
  const t = useT().auth;
  const afterSignIn = useAfterSignIn();
  const enterDemo = useMutation({ mutationFn: () => post("/v1/auth/demo"), onSuccess: () => afterSignIn("/") });
  if (demo)
    return (
      <AuthCard subtitle={t.demoSubtitle} error={enterDemo.error ? (enterDemo.error as Error).message : null}>
        <button className="btn-primary w-full py-2 text-base" autoFocus disabled={enterDemo.isPending} onClick={() => enterDemo.mutate()}>
          {t.enterDemo}
        </button>
        <p className="mt-4 text-xs text-zinc-500">{t.demoNote(demo.reset_minutes)}</p>
      </AuthCard>
    );
  if (setupRequired) return <Navigate to="/setup" replace />;
  const error = params.get("message") ?? (params.get("error") ? t.signInFailed(params.get("error")!) : null);
  const returnTo = params.get("return_to") ?? "/";
  const href = `/v1/auth/oidc/login?return_to=${encodeURIComponent(returnTo)}`;
  return (
    <AuthCard subtitle={t.tagline} error={error}>
      {ssoEnabled && (
        <a href={href} className="btn-primary w-full py-2 text-base" autoFocus>
          {t.signInWith(ssoProvider ?? "SSO")}
        </a>
      )}
      {ssoEnabled && localEnabled && (
        <div className="my-4 flex items-center gap-3 text-xs text-zinc-500">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          {t.orLocal}
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>
      )}
      {localEnabled && <PasswordForm returnTo={returnTo} autoFocus={!ssoEnabled} />}
      {localEnabled && <PasskeyButton returnTo={returnTo} />}
      <p className="mt-4 text-xs text-zinc-500">
        {ssoEnabled && t.ssoAdmins(ssoProvider ?? "SSO")}
        {localEnabled && t.askInvite}
      </p>
    </AuthCard>
  );
}
