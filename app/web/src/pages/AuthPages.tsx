import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

export function LoginPage() {
  const [params] = useSearchParams();
  const { ssoProvider, ssoEnabled } = useAuth();
  const error = params.get("message") ?? (params.get("error") ? `Sign-in failed (${params.get("error")})` : null);
  const returnTo = params.get("return_to") ?? "/";
  const href = `/v1/auth/oidc/login?return_to=${encodeURIComponent(returnTo)}`;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Throwaway Mail</h1>
            <p className="text-sm text-zinc-500">Disposable addresses for every site</p>
          </div>
        </div>
        {error && (
          <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300" role="alert">
            {error}
          </p>
        )}
        {ssoEnabled ? (
          <a href={href} className="btn-primary w-full py-2 text-base" autoFocus>
            Sign in with {ssoProvider}
          </a>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Single sign-on is not configured on this server (OIDC_ISSUER / OIDC_CLIENT_SECRET).
          </p>
        )}
        <p className="mt-4 text-xs text-zinc-500">Accounts come from {ssoProvider}. Admins are the members of its admin group.</p>
      </div>
    </main>
  );
}
