import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, get, setCsrf } from "./api";
import type { User } from "./types";
import { useToast } from "./components/ui";
import { invalidate, invalidateAddress, invalidateNewMail } from "./queries";
import { NOTIFY_KEY } from "./util";

interface AuthState {
  user: User | null;
  loading: boolean;
  ssoEnabled: boolean;
  ssoProvider: string;
  localEnabled: boolean;
  setupRequired: boolean;
  cloudflareMode: "live" | "mock" | "unconfigured" | null;
  /** Public demo (DEMO_MODE): one-click sign-in, data reset every reset_minutes. */
  demo: { reset_minutes: number; reset_at: number | null } | null;
}
const Ctx = createContext<AuthState>({
  user: null,
  loading: true,
  ssoEnabled: false,
  ssoProvider: "SSO",
  localEnabled: false,
  setupRequired: false,
  cloudflareMode: null,
  demo: null,
});
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () =>
      get<{
        sso: { enabled: boolean; provider: string };
        local: { enabled: boolean; setup_required: boolean };
        cloudflare_mode: AuthState["cloudflareMode"];
        demo: AuthState["demo"];
      }>("/v1/auth/status"),
    staleTime: 60_000,
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const r = await get<{ user: User; csrf_token: string }>("/v1/auth/me");
        setCsrf(r.csrf_token);
        return r.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    // A rate limit (429) or a restart must not look like a sign-out: retry with back-off.
    retry: (n, e) => n < 5 && !(e instanceof ApiError && e.status === 401),
    retryDelay: (n) => Math.min(1000 * 2 ** n, 30_000),
    staleTime: 5 * 60_000,
  });
  return (
    <Ctx.Provider
      value={{
        user: me.data ?? null,
        loading: me.isLoading || status.isLoading,
        ssoEnabled: status.data?.sso.enabled ?? false,
        ssoProvider: status.data?.sso.provider ?? "SSO",
        localEnabled: status.data?.local.enabled ?? false,
        setupRequired: status.data?.local.setup_required ?? false,
        cloudflareMode: status.data?.cloudflare_mode ?? null,
        demo: status.data?.demo ?? null,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

/** System notification for a new mail when the tab is in the background (opt-in in Account settings). */
async function notify(e: { address_id: string; subject: string | null; has_code: boolean }) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    localStorage.getItem(NOTIFY_KEY) !== "1" ||
    !document.hidden
  )
    return;
  const code = e.has_code
    ? await get<{ code: string | null } | null>(`/v1/addresses/${e.address_id}/code`)
        .then((r) => r?.code ?? null)
        .catch(() => null)
    : null;
  const n = new Notification(code ? `Code: ${code}` : "New mail", {
    body: `${e.subject ?? "(no subject)"}${code ? "\nClick to copy the code" : ""}`,
    tag: e.address_id,
  });
  n.onclick = () => {
    window.focus();
    if (code) navigator.clipboard.writeText(code).catch(() => {});
    location.assign(`/addresses/${e.address_id}`);
    n.close();
  };
}

/** Subscribes to /v1/events and invalidates cached queries on server-side changes. */
/** Copies a code handed over by the service worker ("Copy code" notification action). */
function useCopyCodeFromNotification(toast: ReturnType<typeof useToast>) {
  useEffect(() => {
    const copy = (code: string) =>
      navigator.clipboard
        .writeText(code)
        .then(() => toast(`Code ${code} copied`, "success"))
        .catch(() => toast(`Code ${code} (copy it manually)`, "success"));
    const m = /^#copy-code=([^&]+)$/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", location.pathname + location.search);
      void copy(decodeURIComponent(m[1]!));
    }
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; code?: unknown } | null;
      if (d?.type === "copy-code" && typeof d.code === "string") void copy(d.code);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [toast]);
}

export function LiveEvents() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  useCopyCodeFromNotification(toast);
  useEffect(() => {
    if (!user) return;
    const es = new EventSource("/v1/events");
    const onMessage = (ev: MessageEvent) => {
      const e = JSON.parse(ev.data) as { address_id: string; subject: string | null; has_code: boolean };
      invalidateNewMail(qc, e.address_id);
      toast(`New mail${e.has_code ? " with a code" : ""}: ${e.subject ?? "(no subject)"}`, "success");
      void notify(e);
    };
    const onAddress = (ev: MessageEvent) => {
      const e = JSON.parse(ev.data) as { address_id: string };
      invalidateAddress(qc, e.address_id);
    };
    es.addEventListener("message.received", onMessage);
    for (const t of ["address.created", "address.updated", "address.deleted"]) es.addEventListener(t, onAddress);
    es.addEventListener("category.changed", () => invalidate(qc, ["categories"], ["saved-searches"]));
    return () => es.close();
  }, [user, qc, toast]);
  return null;
}
