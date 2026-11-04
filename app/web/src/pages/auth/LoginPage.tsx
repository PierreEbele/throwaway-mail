import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ApiError, post } from "../../api";
import { useAuth } from "../../auth";
import { AuthCard, Field, useAfterSignIn } from "./AuthCard";

type LoginResult = { two_factor_required?: boolean; challenge?: string };

/** Second step for accounts with two-factor authentication: a code from the app or a recovery code. */
function CodeForm({ challenge, returnTo, onRestart }: { challenge: string; returnTo: string; onRestart: () => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const afterSignIn = useAfterSignIn();
  const verify = useMutation({
    mutationFn: () => post("/v1/auth/login/2fa", { challenge, code }),
    onSuccess: () => afterSignIn(returnTo),
  });
  const expired = verify.error instanceof ApiError && verify.error.code === "challenge_expired";
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        verify.mutate();
      }}
    >
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {recovery ? "Enter one of your recovery codes. Each code works only once." : "Enter the 6-digit code from your authenticator app."}
      </p>
      {verify.error && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {verify.error.message}
        </p>
      )}
      <Field
        key={recovery ? "recovery" : "totp"}
        id="login-code"
        label={recovery ? "Recovery code" : "Code"}
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
          Start again
        </button>
      ) : (
        <button className="btn-primary w-full py-2 text-base" disabled={verify.isPending}>
          {verify.isPending ? "Checking…" : "Verify"}
        </button>
      )}
      <div className="flex justify-between text-xs">
        <button
          type="button"
          className="text-zinc-500 underline"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
          }}
        >
          {recovery ? "Use the authenticator app" : "Use a recovery code"}
        </button>
        <button type="button" className="text-zinc-500 underline" onClick={onRestart}>
          Back
        </button>
      </div>
    </form>
  );
}

function PasswordForm({ returnTo, autoFocus }: { returnTo: string; autoFocus: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const afterSignIn = useAfterSignIn();
  const login = useMutation({
    mutationFn: () => post<LoginResult>("/v1/auth/login", { email, password }),
    onSuccess: (r) => {
      if (r.two_factor_required && r.challenge) {
        setPassword("");
        setChallenge(r.challenge);
      } else void afterSignIn(returnTo);
    },
  });
  if (challenge)
    return (
      <CodeForm
        challenge={challenge}
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
        label="E-mail"
        type="email"
        autoComplete="username"
        required
        autoFocus={autoFocus}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Field
        id="login-password"
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn-primary w-full py-2 text-base" disabled={login.isPending}>
        {login.isPending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const { ssoProvider, ssoEnabled, localEnabled, setupRequired, demo } = useAuth();
  const afterSignIn = useAfterSignIn();
  const enterDemo = useMutation({ mutationFn: () => post("/v1/auth/demo"), onSuccess: () => afterSignIn("/") });
  if (demo)
    return (
      <AuthCard subtitle="Public demo: simulated mail, reset regularly" error={enterDemo.error ? (enterDemo.error as Error).message : null}>
        <button className="btn-primary w-full py-2 text-base" autoFocus disabled={enterDemo.isPending} onClick={() => enterDemo.mutate()}>
          Enter the demo
        </button>
        <p className="mt-4 text-xs text-zinc-500">
          No account needed. Everything you change is visible to other visitors and reset every {demo.reset_minutes} minutes.
        </p>
      </AuthCard>
    );
  if (setupRequired) return <Navigate to="/setup" replace />;
  const error = params.get("message") ?? (params.get("error") ? `Sign-in failed (${params.get("error")})` : null);
  const returnTo = params.get("return_to") ?? "/";
  const href = `/v1/auth/oidc/login?return_to=${encodeURIComponent(returnTo)}`;
  return (
    <AuthCard subtitle="Disposable addresses for every site" error={error}>
      {ssoEnabled && (
        <a href={href} className="btn-primary w-full py-2 text-base" autoFocus>
          Sign in with {ssoProvider}
        </a>
      )}
      {ssoEnabled && localEnabled && (
        <div className="my-4 flex items-center gap-3 text-xs text-zinc-500">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          or with a local account
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>
      )}
      {localEnabled && <PasswordForm returnTo={returnTo} autoFocus={!ssoEnabled} />}
      <p className="mt-4 text-xs text-zinc-500">
        {ssoEnabled && `${ssoProvider} accounts: admins are the members of its admin group. `}
        {localEnabled && "No local account yet? Ask an admin for an invite link."}
      </p>
    </AuthCard>
  );
}
