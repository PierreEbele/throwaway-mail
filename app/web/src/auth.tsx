import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, get, setCsrf } from "./api";
import type { User } from "./types";
import { useToast } from "./components/ui";

interface AuthState {
  user: User | null;
  loading: boolean;
  ssoEnabled: boolean;
  ssoProvider: string;
  cloudflareMode: "live" | "mock" | "unconfigured" | null;
}
const Ctx = createContext<AuthState>({ user: null, loading: true, ssoEnabled: false, ssoProvider: "SSO", cloudflareMode: null });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => get<{ sso: { enabled: boolean; provider: string }; cloudflare_mode: AuthState["cloudflareMode"] }>("/v1/auth/status"),
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
    staleTime: 5 * 60_000,
  });
  return (
    <Ctx.Provider
      value={{
        user: me.data ?? null,
        loading: me.isLoading || status.isLoading,
        ssoEnabled: status.data?.sso.enabled ?? false,
        ssoProvider: status.data?.sso.provider ?? "SSO",
        cloudflareMode: status.data?.cloudflare_mode ?? null,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

/** System notification for a new mail when the tab is in the background (opt-in in Account settings). */
async function notify(e: { address_id: string; subject: string | null; has_code: boolean }) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || localStorage.getItem("notify-new-mail") !== "1" || !document.hidden) return;
  const code = e.has_code ? await get<{ code: string | null } | null>(`/v1/addresses/${e.address_id}/code`).then((r) => r?.code ?? null).catch(() => null) : null;
  const n = new Notification(code ? `Code: ${code}` : "New mail", { body: `${e.subject ?? "(no subject)"}${code ? "\nClick to copy the code" : ""}`, tag: e.address_id });
  n.onclick = () => {
    window.focus();
    if (code) navigator.clipboard.writeText(code).catch(() => {});
    location.assign(`/addresses/${e.address_id}`);
    n.close();
  };
}

/** Subscribes to /v1/events and invalidates cached queries on server-side changes. */
export function LiveEvents() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    const es = new EventSource("/v1/events");
    const onMessage = (ev: MessageEvent) => {
      const e = JSON.parse(ev.data) as { address_id: string; subject: string | null; has_code: boolean };
      qc.invalidateQueries({ queryKey: ["addresses"] });
      qc.invalidateQueries({ queryKey: ["address", e.address_id] });
      qc.invalidateQueries({ queryKey: ["messages", e.address_id] });
      qc.invalidateQueries({ queryKey: ["code", e.address_id] });
      qc.invalidateQueries({ queryKey: ["stats", e.address_id] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["digest"] });
      qc.invalidateQueries({ queryKey: ["review"] });
      qc.invalidateQueries({ queryKey: ["review-count"] });
      toast(`New mail${e.has_code ? " with a code" : ""}: ${e.subject ?? "(no subject)"}`, "success");
      void notify(e);
    };
    const onAddress = (ev: MessageEvent) => {
      const e = JSON.parse(ev.data) as { address_id: string };
      qc.invalidateQueries({ queryKey: ["addresses"] });
      qc.invalidateQueries({ queryKey: ["address", e.address_id] });
      qc.invalidateQueries({ queryKey: ["messages", e.address_id] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["stale"] });
    };
    es.addEventListener("message.received", onMessage);
    for (const t of ["address.created", "address.updated", "address.deleted"]) es.addEventListener(t, onAddress);
    es.addEventListener("category.changed", () => qc.invalidateQueries({ queryKey: ["categories"] }));
    return () => es.close();
  }, [user, qc, toast]);
  return null;
}
