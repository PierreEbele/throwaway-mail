import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { get, post } from "../../api";
import { Spinner } from "../../components/ui";
import { AuthCard, Field, PASSWORD_MIN, useAfterSignIn } from "./AuthCard";

interface InviteInfo {
  valid: boolean;
  email: string | null;
  role: "admin" | "user" | null;
  reset: boolean;
}

/** /invite/:token: accept an invite (new local account) or a password reset link. */
export function InvitePage() {
  const token = encodeURIComponent(useParams().token ?? "");
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => get<InviteInfo>(`/v1/auth/invite/${token}`) });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const afterSignIn = useAfterSignIn();
  const accept = useMutation({
    mutationFn: () => post(`/v1/auth/invite/${token}`, { name: name || undefined, password }),
    onSuccess: () => afterSignIn(),
  });
  if (info.isLoading) return <Spinner />;
  const inv = info.data;
  if (!inv?.valid)
    return (
      <AuthCard subtitle="Invite" error={info.error}>
        <p className="text-sm">This link is invalid, expired or already used. Ask an admin for a new one.</p>
        <Link to="/login" className="btn-secondary mt-4 w-full">
          Go to sign-in
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard subtitle={inv.reset ? "Choose a new password" : "Create your account"} error={accept.error}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          accept.mutate();
        }}
      >
        <p className="text-sm">
          {inv.reset ? "Account" : "Invited as"} <strong>{inv.email}</strong>
          {!inv.reset && inv.role === "admin" && " (admin)"}
        </p>
        {/* Lets password managers store the new password under the right account. */}
        <input type="email" hidden readOnly autoComplete="username" value={inv.email ?? ""} />
        {!inv.reset && (
          <Field id="invite-name" label="Name (optional)" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <Field
          id="invite-password"
          label={inv.reset ? "New password" : "Password"}
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          minLength={PASSWORD_MIN}
          hint={`At least ${PASSWORD_MIN} characters.${inv.reset ? " Your other sessions are signed out." : ""}`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn-primary w-full py-2 text-base" disabled={accept.isPending}>
          {inv.reset ? "Set password and sign in" : "Create account"}
        </button>
      </form>
    </AuthCard>
  );
}
