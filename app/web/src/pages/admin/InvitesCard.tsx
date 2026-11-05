import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../../api";
import type { Role } from "../../types";
import { Badge, CopyButton, ErrorText, Modal, confirmAction, useToast } from "../../components/ui";
import { fullDate } from "../../util";
import { useT } from "../../i18n";

export interface Invite {
  id: string;
  email: string;
  role: Role;
  reset: boolean;
  created_at: number;
  expires_at: number;
}

const INVITES_KEY = ["admin-invites"];

/** Creates an invite, or a password reset link when the e-mail belongs to an existing local account. */
export function useCreateInvite() {
  const qc = useQueryClient();
  const [link, setLink] = useState<{ url: string; invite: Invite } | null>(null);
  const t = useT().ops.invites;
  const create = useMutation({
    mutationFn: (v: { email: string; role: Role }) => post<{ url: string; invite: Invite }>("/v1/admin/invites", v),
    onSuccess: (r) => {
      setLink(r);
      qc.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
  const dialog = (
    <Modal open={!!link} onClose={() => setLink(null)} title={link?.invite.reset ? t.resetLink : t.inviteLink}>
      <p className="mb-3 text-sm">
        {t.sendLink} <strong>{link?.invite.email}</strong>
        {t.expiresOn(fullDate(link?.invite.expires_at))}
      </p>
      <p className="mb-3 rounded-md bg-zinc-100 p-2 font-mono text-xs break-all dark:bg-zinc-800">{link?.url}</p>
      <CopyButton text={link?.url ?? ""} label={t.copyLink} />
    </Modal>
  );
  return { create, dialog };
}

export function InvitesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const t = useT().ops.invites;
  const tc = useT().common;
  const { create, dialog } = useCreateInvite();
  const invites = useQuery({
    queryKey: INVITES_KEY,
    queryFn: () => get<{ invites: Invite[] }>("/v1/admin/invites").then((r) => r.invites),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/v1/admin/invites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: INVITES_KEY }),
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <div className="card mb-6 p-4">
      <h2 className="mb-3 font-semibold">{t.title}</h2>
      <form
        className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate({ email, role }, { onSuccess: () => setEmail("") });
        }}
      >
        <div>
          <label htmlFor="inv-email" className="label">
            {t.email}
          </label>
          <input id="inv-email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="inv-role" className="label">
            {t.role}
          </label>
          <select id="inv-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="user">{tc.status.user}</option>
            <option value="admin">{tc.status.admin}</option>
          </select>
        </div>
        <button className="btn-primary" disabled={create.isPending}>
          {t.create}
        </button>
      </form>
      <div className="mt-3">
        <ErrorText error={create.error ?? invites.error} />
      </div>
      {!!invites.data?.length && (
        <ul className="mt-4 divide-y divide-zinc-200 border-t border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {invites.data.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate">
                {i.email} <span className="text-xs text-zinc-500">{t.expires(fullDate(i.expires_at))}</span>
              </span>
              <Badge value={i.reset ? "pending" : i.role}>{i.reset ? t.passwordReset : tc.status[i.role]}</Badge>
              <button className="btn-ghost" onClick={() => confirmAction(t.confirmRevoke(i.email)) && revoke.mutate(i.id)}>
                {t.revoke}
              </button>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </div>
  );
}
