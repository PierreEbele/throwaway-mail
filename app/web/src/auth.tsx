import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, get, setCsrf } from "./api";
import type { User } from "./types";
import { useToast } from "./components/ui";

interface AuthState {
  user: User | null;
  loading: boolean;
  needsSetup: boolean;
  cloudflareMode: "live" | "mock" | null;
}
const Ctx = createContext<AuthState>({ user: null, loading: true, needsSetup: false, cloudflareMode: null });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const status = useQuery({ queryKey: ["status"], queryFn: () => get<{ needs_setup: boolean; cloudflare_mode: "live" | "mock" }>("/v1/auth/status"), staleTime: 60_000 });
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
        needsSetup: status.data?.needs_setup ?? false,
        cloudflareMode: status.data?.cloudflare_mode ?? null,
      }}
    >
      {children}
    </Ctx.Provider>
  );
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
      toast(`New mail${e.has_code ? " with a code" : ""}: ${e.subject ?? "(no subject)"}`, "success");
    };
    const onAddress = (ev: MessageEvent) => {
      const e = JSON.parse(ev.data) as { address_id: string };
      qc.invalidateQueries({ queryKey: ["addresses"] });
      qc.invalidateQueries({ queryKey: ["address", e.address_id] });
      qc.invalidateQueries({ queryKey: ["messages", e.address_id] });
    };
    es.addEventListener("message.received", onMessage);
    for (const t of ["address.created", "address.updated", "address.deleted"]) es.addEventListener(t, onAddress);
    return () => es.close();
  }, [user, qc, toast]);
  return null;
}
