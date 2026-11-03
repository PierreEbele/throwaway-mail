import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Domain, User } from "../../types";
import { ErrorText, useToast } from "../../components/ui";
import { useAuth } from "../../auth";
import { MailboxFields, mailboxDraft, mailboxPayload } from "./MailboxFields";

export const POLICY_HELP: Record<Domain["unknown_policy"], string> = {
  reject: "Reject mail for addresses that do not exist",
  inbox: "Keep it in your “Unassigned” inbox",
  auto_create: "Create the address automatically (catch-all style)",
};

const TRANSPORTS: Record<Domain["transport"], string> = {
  cloudflare: "Cloudflare Email Routing",
  imap: "IMAP + SMTP mailbox",
};

export function AddDomainForm({ users }: { users: User[] | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { cloudflareMode } = useAuth();
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<Domain["unknown_policy"]>("reject");
  const [ownerId, setOwnerId] = useState("");
  const [transport, setTransport] = useState<Domain["transport"]>(cloudflareMode === "unconfigured" ? "imap" : "cloudflare");
  const [mailbox, setMailbox] = useState(() => mailboxDraft());
  const add = useMutation({
    mutationFn: () =>
      post<{ domain: Domain }>("/v1/domains", {
        name,
        unknown_policy: policy,
        owner_id: ownerId || undefined,
        transport,
        ...(transport === "imap" ? { mailbox: mailboxPayload(mailbox) } : {}),
      }),
    onSuccess: (r) => {
      setName("");
      setMailbox(mailboxDraft());
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast(`${r.domain.name}: ${r.domain.status}`, r.domain.status === "active" ? "success" : "info");
    },
  });
  return (
    <form
      className="card mb-6 space-y-4 p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div role="radiogroup" aria-label="How mail reaches the app" className="flex flex-wrap gap-4 text-sm">
        {(Object.keys(TRANSPORTS) as Domain["transport"][]).map((k) => (
          <label key={k} className="flex items-center gap-2">
            <input type="radio" name="transport" checked={transport === k} onChange={() => setTransport(k)} />
            {TRANSPORTS[k]}
            {k === "cloudflare" && cloudflareMode === "unconfigured" && <span className="text-xs text-zinc-500">(not configured)</span>}
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr] sm:items-end">
        <div>
          <label htmlFor="dom-name" className="label">
            Domain name
          </label>
          <input
            id="dom-name"
            required
            className="input"
            placeholder="mail.example.com"
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
          />
        </div>
        <div>
          <label htmlFor="dom-policy" className="label">
            Unknown addresses
          </label>
          <select id="dom-policy" className="input" value={policy} onChange={(e) => setPolicy(e.target.value as Domain["unknown_policy"])}>
            {Object.keys(POLICY_HELP).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dom-owner" className="label">
            Owner
          </label>
          <select id="dom-owner" className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Me</option>
            {users?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
        </div>
      </div>
      {transport === "imap" && <MailboxFields value={mailbox} onChange={setMailbox} />}
      <p className="text-xs text-zinc-500">
        Unknown addresses: {POLICY_HELP[policy]}. The owner receives the domain's “To sort” box.{" "}
        {transport === "imap"
          ? "The mailbox must receive all mail of the domain (catch-all or alias); the connection is tested before the domain becomes active."
          : "Its DNS must be on Cloudflare: Email Routing is enabled and its catch-all rule pointed at the Worker."}
      </p>
      <button className="btn-primary" disabled={add.isPending}>
        {add.isPending ? (transport === "imap" ? "Testing connection…" : "Configuring Cloudflare…") : "Add domain"}
      </button>
      <ErrorText error={add.error} />
    </form>
  );
}
