import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { get, post } from "../../api";
import { Spinner } from "../../components/ui";
import { AuthCard, Field, PASSWORD_MIN, useAfterSignIn, useT } from "./AuthCard";

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
  const t = useT().auth;
  const accept = useMutation({
    mutationFn: () => post<{ sign_in_required?: boolean }>(`/v1/auth/invite/${token}`, { name: name || undefined, password }),
    // After a reset, an account with a second factor gets no session: it signs in normally.
    onSuccess: (res) => (res?.sign_in_required ? undefined : afterSignIn()),
  });
  if (info.isLoading) return <Spinner />;
  if (accept.data?.sign_in_required)
    return (
      <AuthCard subtitle={t.newPassword}>
        <p className="text-sm">{t.passwordSetSignIn}</p>
        <Link to="/login" className="btn-primary mt-4 w-full">
          {t.goSignIn}
        </Link>
      </AuthCard>
    );
  const inv = info.data;
  if (!inv?.valid)
    return (
      <AuthCard subtitle={t.invite} error={info.error}>
        <p className="text-sm">{t.invalidInvite}</p>
        <Link to="/login" className="btn-secondary mt-4 w-full">
          {t.goSignIn}
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard subtitle={inv.reset ? t.newPassword : t.createYourAccount} error={accept.error}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          accept.mutate();
        }}
      >
        <p className="text-sm">
          {inv.reset ? t.account : t.invitedAs} <strong>{inv.email}</strong>
          {!inv.reset && inv.role === "admin" && t.adminSuffix}
        </p>
        {/* Lets password managers store the new password under the right account. */}
        <input type="email" hidden readOnly autoComplete="username" value={inv.email ?? ""} />
        {!inv.reset && (
          <Field id="invite-name" label={t.nameOptional} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <Field
          id="invite-password"
          label={inv.reset ? t.newPasswordLabel : t.password}
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          minLength={PASSWORD_MIN}
          hint={t.minChars(PASSWORD_MIN) + (inv.reset ? t.otherSessions : "")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn-primary w-full py-2 text-base" disabled={accept.isPending}>
          {inv.reset ? t.setAndSignIn : t.createAccount}
        </button>
      </form>
    </AuthCard>
  );
}
