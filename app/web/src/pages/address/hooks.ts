import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address } from "../../types";
import { confirmAction, useToast } from "../../components/ui";
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

/** Creates a fresh address for the site, pauses this one and opens the site so the user can switch. */
export function useReplace(a: Address) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  return () =>
    confirmAction(`Create a new address for ${a.site_name} and pause ${a.email}? You will then need to change the e-mail on the site.`) &&
    post<{ address: Address }>(`/v1/addresses/${a.id}/replace`, {}).then(
      (r) => {
        qc.invalidateQueries();
        navigator.clipboard.writeText(r.address.email).catch(() => {});
        toast(`New address ${r.address.email} copied — update it on the site`, "success");
        if (a.site_url) window.open(a.site_url, "_blank", "noopener,noreferrer");
        nav(`/addresses/${r.address.id}`);
      },
      (e: Error) => toast(e.message, "error"),
    );
}
