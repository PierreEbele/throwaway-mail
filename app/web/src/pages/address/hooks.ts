import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address } from "../../types";
import { confirmAction, useToast } from "../../components/ui";
import { msg } from "../../i18n";
import { invalidate } from "../../queries";

export function useSenderAction(id: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (b: { action: string; sender?: string }) => post<{ address: Address }>(`/v1/addresses/${id}/senders`, b),
    onSuccess: (r) => {
      qc.setQueryData(["address", id], r.address);
      invalidate(qc, ["addresses"], ["digest"]);
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
}

/**
 * "This site rejected the address": records site + domain (new addresses for the site avoid it) and replaces the
 * address with one on another domain when there is one.
 */
export function useSiteRejected(a: Address) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  return () =>
    confirmAction(msg().address.confirmRejected(a.site_name, a.domain, a.email)) &&
    post<{ address: Address | null; other_domains: number }>(`/v1/addresses/${a.id}/rejected`, { replace: true }).then(
      (r) => {
        qc.invalidateQueries();
        if (!r.address) return;
        navigator.clipboard.writeText(r.address.email).catch(() => {});
        toast(msg().address.newCopiedTry(r.address.email), "success");
        nav(`/addresses/${r.address.id}`);
      },
      (e: Error) =>
        post(`/v1/addresses/${a.id}/rejected`, { replace: false }).then(() => {
          qc.invalidateQueries();
          toast(msg().address.rejectionRecorded(e.message), "error");
        }),
    );
}

/** Creates a fresh address for the site, pauses this one and opens the site so the user can switch. */
export function useReplace(a: Address) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  return () =>
    confirmAction(msg().address.confirmReplace(a.site_name, a.email)) &&
    post<{ address: Address }>(`/v1/addresses/${a.id}/replace`, {}).then(
      (r) => {
        qc.invalidateQueries();
        navigator.clipboard.writeText(r.address.email).catch(() => {});
        toast(msg().address.newCopiedUpdate(r.address.email), "success");
        if (a.site_url) window.open(a.site_url, "_blank", "noopener,noreferrer");
        nav(`/addresses/${r.address.id}`);
      },
      (e: Error) => toast(e.message, "error"),
    );
}
