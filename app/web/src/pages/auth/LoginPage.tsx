import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { post } from "../../api";
import { useAuth } from "../../auth";
import { AuthCard, Field, useAfterSignIn } from "./AuthCard";

function PasswordForm({ returnTo, autoFocus }: { returnTo: string; autoFocus: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const afterSignIn = useAfterSignIn();
  const login = useMutation({
    mutationFn: () => post("/v1/auth/login", { email, password }),
    onSuccess: () => afterSignIn(returnTo),
  });
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
  const { ssoProvider, ssoEnabled, localEnabled, setupRequired } = useAuth();
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
