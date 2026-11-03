import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, patch } from "../../api";
import type { Address, CodeResult, MessageSummary } from "../../types";
import { ErrorText, Spinner, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { useDestinations } from "../Addresses";
import { AddressHeader } from "./AddressHeader";
import { CodeCard } from "./CodeCard";
import { EditSiteDialog } from "./EditSiteDialog";
import { ForwardingCard } from "./ForwardingCard";
import { MessagesPane, type Box } from "./MessagesPane";
import { ProtectionCard } from "./ProtectionCard";
import { SendersCard } from "./SendersCard";
import { StatsCard } from "./StatsCard";

export function AddressDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const address = useQuery({
    queryKey: ["address", id],
    queryFn: () => get<{ address: Address }>(`/v1/addresses/${id}`).then((r) => r.address),
  });
  const [box, setBox] = useState<Box>("inbox");
  const messages = useQuery({
    queryKey: ["messages", id, box],
    queryFn: () =>
      get<{ messages: MessageSummary[] }>(`/v1/addresses/${id}/messages?limit=200&archived=${box === "archive"}`).then((r) => r.messages),
  });
  const code = useQuery({ queryKey: ["code", id], queryFn: () => get<CodeResult | null>(`/v1/addresses/${id}/code`) });
  const dests = useDestinations();
  const [editing, setEditing] = useState(false);
  const [sp] = useSearchParams();
  const back = sp.toString() ? `/?${sp.toString()}` : "/";

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<{ address: Address }>(`/v1/addresses/${id}`, body),
    onSuccess: (r) => {
      qc.setQueryData(["address", id], r.address);
      invalidate(qc, ["addresses"], ["categories"], ["stale"]);
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const onUpdate = (body: Record<string, unknown>) => update.mutate(body);

  if (address.isLoading) return <Spinner />;
  if (address.error || !address.data) return <ErrorText error={address.error ?? "Not found"} />;
  const a = address.data;

  return (
    <div className="space-y-6">
      <AddressHeader a={a} back={back} onUpdate={onUpdate} onEdit={() => setEditing(true)} />
      <div className="grid gap-4 2xl:grid-cols-3">
        <CodeCard code={code} />
        <ForwardingCard a={a} dests={dests.data} onUpdate={onUpdate} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <StatsCard id={a.id} />
        <SendersCard a={a} />
        <ProtectionCard a={a} onChange={onUpdate} />
      </div>
      <MessagesPane a={a} box={box} setBox={setBox} messages={messages} />
      <EditSiteDialog address={a} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}
