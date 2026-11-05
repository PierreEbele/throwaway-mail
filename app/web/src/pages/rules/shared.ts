import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../api";
import type { Address, Rule } from "../../types";
import { useDestinations } from "../Addresses";
import { useCategories } from "../mailbox/shared";
import { useT } from "../../i18n";

export type Draft = Omit<Rule, "id" | "position" | "match_count" | "last_matched_at" | "created_at" | "updated_at"> & { id?: string };

export const EMPTY: Draft = {
  name: "",
  enabled: true,
  match: "all",
  conditions: [{ type: "sender_domain", value: "" }],
  actions: [{ type: "quarantine" }],
  address_id: null,
  category_id: null,
};

export function useAddresses() {
  return useQuery({
    queryKey: ["addresses", "all-for-rules"],
    queryFn: () => get<{ addresses: Address[] }>("/v1/addresses?limit=1000").then((r) => r.addresses),
  });
}

export function useNames() {
  const cats = useCategories();
  const dests = useDestinations();
  const addrs = useAddresses();
  const t = useT().rules;
  return useMemo(
    () => ({
      category: (id: string) => cats.data?.find((c) => c.id === id)?.name ?? t.deletedCategory,
      destination: (id: string) => dests.data?.find((d) => d.id === id)?.email ?? t.deletedMailbox,
      address: (id: string) => addrs.data?.find((a) => a.id === id)?.email ?? t.deletedAddress,
    }),
    [cats.data, dests.data, addrs.data, t],
  );
}
