import type { InputHTMLAttributes, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorText } from "../../components/ui";

export const PASSWORD_MIN = 10;

/** Centered card shared by the login, setup and invite pages. */
export function AuthCard({ subtitle, error, children }: { subtitle: string; error?: unknown; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Throwaway Mail</h1>
            <p className="text-sm text-zinc-500">{subtitle}</p>
          </div>
        </div>
        {!!error && (
          <div className="mb-4">
            <ErrorText error={error} />
          </div>
        )}
        {children}
      </div>
    </main>
  );
}

export { useT } from "../../i18n";

export function Field({ id, label, hint, ...input }: { id: string; label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input id={id} className="input" {...input} />
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

/** After a password sign-in the session cookie is set: reload the user, then go into the app. */
export function useAfterSignIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async (to = "/") => {
    await Promise.all([qc.refetchQueries({ queryKey: ["me"] }), qc.refetchQueries({ queryKey: ["status"] })]);
    navigate(to, { replace: true });
  };
}
