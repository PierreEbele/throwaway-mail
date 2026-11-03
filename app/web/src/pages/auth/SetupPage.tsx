import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { post } from "../../api";
import { useAuth } from "../../auth";
import { AuthCard, Field, PASSWORD_MIN, useAfterSignIn } from "./AuthCard";

/** First run with local accounts: create the first admin. */
export function SetupPage() {
  const { setupRequired } = useAuth();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const afterSignIn = useAfterSignIn();
  const setup = useMutation({
    mutationFn: () => post("/v1/auth/setup", { email, name: name || undefined, password }),
    onSuccess: () => afterSignIn(),
  });
  if (!setupRequired && !setup.isSuccess) return <Navigate to="/login" replace />;
  return (
    <AuthCard subtitle="Create the first admin account" error={setup.error}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setup.mutate();
        }}
      >
        <Field
          id="setup-email"
          label="E-mail"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field id="setup-name" label="Name (optional)" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          id="setup-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          hint={`At least ${PASSWORD_MIN} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn-primary w-full py-2 text-base" disabled={setup.isPending}>
          Create admin account
        </button>
      </form>
    </AuthCard>
  );
}
