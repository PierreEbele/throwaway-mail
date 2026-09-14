import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api";
import { ErrorText } from "../components/ui";

function Shell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            {subtitle && <p className="text-sm text-zinc-500">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

function useAfterLogin() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return async () => {
    await qc.invalidateQueries();
    nav("/");
  };
}

function Field({ id, label, ...rest }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <input id={id} name={id} className="input" {...rest} />
    </div>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const done = useAfterLogin();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/v1/auth/login", { email, password });
      await done();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Throwaway Mail" subtitle="Sign in to your account">
      <form onSubmit={submit} className="space-y-4">
        <Field id="email" label="Email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={error} />
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="text-xs text-zinc-500">Access is invite-only. Ask your admin for an invite link.</p>
      </form>
    </Shell>
  );
}

export function SetupPage() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const done = useAfterLogin();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await post("/v1/auth/setup", { token: token.trim(), email, password });
      await done();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Shell title="First-time setup" subtitle="Create the administrator account">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Paste the one-time <strong>setup token</strong> printed in the server logs (<code className="text-xs">docker compose logs app | grep setup_token</code>).
        </p>
        <Field id="token" label="Setup token" required autoFocus autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        <Field id="email" label="Admin email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password (min. 10 characters)" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={error} />
        <button className="btn-primary w-full">Create admin</button>
      </form>
    </Shell>
  );
}

export function InvitePage() {
  const { token = "" } = useParams();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => get<{ email: string | null; role: string }>(`/v1/auth/invite/${encodeURIComponent(token)}`), retry: false });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const done = useAfterLogin();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await post("/v1/auth/accept-invite", { token, email: info.data?.email ? undefined : email, password });
      await done();
    } catch (err) {
      setError(err);
    }
  };
  if (info.isLoading) return <Shell title="Accept invite">Checking invite…</Shell>;
  if (info.error) return <Shell title="Accept invite"><ErrorText error={info.error} /></Shell>;
  return (
    <Shell title="Accept invite" subtitle={`You were invited as ${info.data?.role}`}>
      <form onSubmit={submit} className="space-y-4">
        {info.data?.email ? (
          <p className="text-sm">Account email: <strong>{info.data.email}</strong></p>
        ) : (
          <Field id="email" label="Your email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        )}
        <Field id="password" label="Choose a password (min. 10 characters)" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={error} />
        <button className="btn-primary w-full">Create account</button>
      </form>
    </Shell>
  );
}
