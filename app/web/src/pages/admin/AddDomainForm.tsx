import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Domain, User } from "../../types";
import { ErrorText, useToast } from "../../components/ui";
import { useAuth } from "../../auth";
import { MailboxFields, mailboxDraft, mailboxPayload } from "./MailboxFields";
import { msg, useT } from "../../i18n";

export const POLICIES: Domain["unknown_policy"][] = ["reject", "inbox", "auto_create"];

export function AddDomainForm({ users }: { users: User[] | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { cloudflareMode } = useAuth();
  const t = useT().domainSetup;
  const POLICY_HELP = t.policyHelp;
  const TRANSPORTS = t.transports;
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
      toast(
        `${r.domain.name}: ${msg().common.status[r.domain.status] ?? r.domain.status}`,
        r.domain.status === "active" ? "success" : "info",
      );
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
      <div role="radiogroup" aria-label={t.howMail} className="flex flex-wrap gap-4 text-sm">
        {(Object.keys(TRANSPORTS) as Domain["transport"][]).map((k) => (
          <label key={k} className="flex items-center gap-2">
            <input type="radio" name="transport" checked={transport === k} onChange={() => setTransport(k)} />
            {TRANSPORTS[k]}
            {k === "cloudflare" && cloudflareMode === "unconfigured" && <span className="text-xs text-zinc-500">{t.notConfigured}</span>}
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr] sm:items-end">
        <div>
          <label htmlFor="dom-name" className="label">
            {t.domainName}
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
            {t.unknownAddresses}
          </label>
          <select id="dom-policy" className="input" value={policy} onChange={(e) => setPolicy(e.target.value as Domain["unknown_policy"])}>
            {POLICIES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dom-owner" className="label">
            {t.owner}
          </label>
          <select id="dom-owner" className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">{t.me}</option>
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
        {t.help(POLICY_HELP[policy])} {transport === "imap" ? t.helpImap : t.helpCf}
      </p>
      <button className="btn-primary" disabled={add.isPending}>
        {add.isPending ? (transport === "imap" ? t.testing : t.configuring) : t.add}
      </button>
      <ErrorText error={add.error} />
    </form>
  );
}
