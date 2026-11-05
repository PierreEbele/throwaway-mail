import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../../api";
import type { Domain, User } from "../../types";
import { EmptyState, PageHeader, Spinner, useToast } from "../../components/ui";
import { useDomains } from "../Addresses";
import { AddDomainForm } from "./AddDomainForm";
import { DomainCard } from "./DomainCard";
import { SiteRejectionsCard } from "../settings/DomainChoiceCard";
import { msg, useT } from "../../i18n";

export function DomainsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const t = useT().admin.domains;
  const usersQ = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const setOwner = useMutation({
    mutationFn: ({ id, owner }: { id: string; owner: string }) => patch(`/v1/domains/${id}`, { owner_id: owner }),
    onSuccess: () => {
      inv();
      toast(t.ownerChanged, "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["domains"] });
  };
  const verify = useMutation({
    mutationFn: (id: string) => post<{ domain: Domain }>(`/v1/domains/${id}/verify`),
    onSuccess: (r) => {
      inv();
      toast(
        `${r.domain.name}: ${msg().common.status[r.domain.status] ?? r.domain.status}`,
        r.domain.status === "active" ? "success" : "info",
      );
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const setPolicyM = useMutation({
    mutationFn: ({ id, p }: { id: string; p: string }) => patch(`/v1/domains/${id}`, { unknown_policy: p }),
    onSuccess: inv,
  });
  const setForwardUnknown = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => patch(`/v1/domains/${id}`, { forward_unknown: on }),
    onSuccess: inv,
    onError: (e) => toast((e as Error).message, "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/v1/domains/${id}`),
    onSuccess: inv,
    onError: (e) => toast((e as Error).message, "error"),
  });

  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <AddDomainForm users={usersQ.data} />
      {domains.isLoading && <Spinner />}
      {domains.data?.length === 0 && <EmptyState title={t.emptyTitle}>{t.emptyBody}</EmptyState>}
      <ul className="space-y-3">
        {domains.data?.map((d) => (
          <DomainCard
            key={d.id}
            d={d}
            users={usersQ.data}
            onOwner={(owner) => setOwner.mutate({ id: d.id, owner })}
            onPolicy={(p) => setPolicyM.mutate({ id: d.id, p })}
            onVerify={() => verify.mutate(d.id)}
            verifying={verify.isPending && verify.variables === d.id}
            onRemove={() => remove.mutate(d.id)}
            onForwardUnknown={(on) => setForwardUnknown.mutate({ id: d.id, on })}
          />
        ))}
      </ul>
      <SiteRejectionsCard />
    </>
  );
}
