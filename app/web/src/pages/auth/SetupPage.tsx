import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { post } from "../../api";
import { useAuth } from "../../auth";
import { AuthCard, Field, PASSWORD_MIN, useAfterSignIn, useT } from "./AuthCard";

/** First run with local accounts: create the first admin. */
export function SetupPage() {
  const { setupRequired } = useAuth();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const afterSignIn = useAfterSignIn();
  const t = useT().auth;
  const setup = useMutation({
    mutationFn: () => post("/v1/auth/setup", { email, name: name || undefined, password }),
    onSuccess: () => afterSignIn(),
  });
  if (!setupRequired && !setup.isSuccess) return <Navigate to="/login" replace />;
  return (
    <AuthCard subtitle={t.setupSubtitle} error={setup.error}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setup.mutate();
        }}
      >
        <Field
          id="setup-email"
          label={t.email}
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field id="setup-name" label={t.nameOptional} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          id="setup-password"
          label={t.password}
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          hint={t.minChars(PASSWORD_MIN)}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn-primary w-full py-2 text-base" disabled={setup.isPending}>
          {t.createAdmin}
        </button>
      </form>
    </AuthCard>
  );
}
