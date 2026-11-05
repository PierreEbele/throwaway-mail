import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "../../api";
import type { Domain, User } from "../../types";
import { EmptyState, PageHeader, Spinner, useToast } from "../../components/ui";
import { useDomains } from "../Addresses";
import { AddDomainForm } from "./AddDomainForm";
import { DomainCard } from "./DomainCard";
import { SiteRejectionsCard } from "../settings/DomainChoiceCard";

export function DomainsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const usersQ = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const setOwner = useMutation({
    mutationFn: ({ id, owner }: { id: string; owner: string }) => patch(`/v1/domains/${id}`, { owner_id: owner }),
    onSuccess: () => {
      inv();
      toast("Owner changed: the domain's To sort box moved with it", "success");
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
      toast(`${r.domain.name}: ${r.domain.status}`, r.domain.status === "active" ? "success" : "info");
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
      <PageHeader
        title="Domains"
        subtitle="Shared by all users. Mail arrives through Cloudflare Email Routing (catch-all rule → Worker) or is polled from an IMAP catch-all mailbox and forwarded over SMTP."
      />
      <AddDomainForm users={usersQ.data} />
      {domains.isLoading && <Spinner />}
      {domains.data?.length === 0 && (
        <EmptyState title="No domains yet">
          Add the first domain above: on Cloudflare, or with any provider offering a catch-all IMAP mailbox.
        </EmptyState>
      )}
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
