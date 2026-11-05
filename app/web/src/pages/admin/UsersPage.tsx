import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch } from "../../api";
import type { Role, User } from "../../types";
import { InvitesCard, useCreateInvite } from "./InvitesCard";
import { useAuth } from "../../auth";
import { Badge, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../../components/ui";
import { timeAgo } from "../../util";
import { useT } from "../../i18n";

export function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me, ssoEnabled, ssoProvider, localEnabled } = useAuth();
  const t = useT().admin.users;
  const tc = useT().common;
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const updateUser = useMutation({
    mutationFn: ({ id, ...body }: { id: string; disabled?: boolean; role?: Role }) => patch(`/v1/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const reset2fa = useMutation({
    mutationFn: (id: string) => del(`/v1/admin/users/${id}/2fa`),
    onSuccess: () => {
      toast(t.twoFaOff, "success");
      return qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const { create: resetLink, dialog } = useCreateInvite();
  const subtitle = [ssoEnabled && t.ssoNote(ssoProvider ?? "SSO"), localEnabled && t.localNote, t.privateNote].filter(Boolean).join(" ");
  return (
    <>
      <PageHeader title={t.title} subtitle={subtitle} />
      {localEnabled && <InvitesCard />}
      {users.isLoading && <Spinner />}
      <ErrorText error={users.error ?? resetLink.error} />
      <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
        {users.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate">{u.name ?? u.email}</div>
              <div className="truncate text-xs text-zinc-500">
                {u.email} · {u.auth === "local" ? t.localAccount : ssoProvider} · {t.lastSignIn(timeAgo(u.last_login_at))}
              </div>
            </div>
            {u.auth === "local" ? (
              <select
                className="input w-auto"
                aria-label={t.roleOf(u.email)}
                value={u.role}
                onChange={(e) => updateUser.mutate({ id: u.id, role: e.target.value as Role })}
              >
                <option value="user">{tc.status.user}</option>
                <option value="admin">{tc.status.admin}</option>
              </select>
            ) : (
              <Badge value={u.role} />
            )}
            {u.disabled && <Badge value="disabled" />}
            {u.two_factor && (
              <>
                <Badge value="2FA" />
                <button className="btn-ghost" onClick={() => confirmAction(t.confirmReset2fa(u.email)) && reset2fa.mutate(u.id)}>
                  {t.reset2fa}
                </button>
              </>
            )}
            {localEnabled && u.auth === "local" && (
              <button
                className="btn-ghost"
                onClick={() => confirmAction(t.confirmResetPw(u.email)) && resetLink.mutate({ email: u.email, role: u.role })}
              >
                {t.resetPw}
              </button>
            )}
            {u.id !== me?.id && (
              <button
                className="btn-ghost"
                onClick={() =>
                  (u.disabled || confirmAction(t.confirmDisable(u.email))) && updateUser.mutate({ id: u.id, disabled: !u.disabled })
                }
              >
                {u.disabled ? t.enable : t.disable}
              </button>
            )}
          </li>
        ))}
      </ul>
      {dialog}
    </>
  );
}
