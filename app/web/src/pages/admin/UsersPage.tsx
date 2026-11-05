import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch } from "../../api";
import type { Role, User } from "../../types";
import { InvitesCard, useCreateInvite } from "./InvitesCard";
import { useAuth } from "../../auth";
import { Badge, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../../components/ui";
import { timeAgo } from "../../util";

export function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me, ssoEnabled, ssoProvider, localEnabled } = useAuth();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const updateUser = useMutation({
    mutationFn: ({ id, ...body }: { id: string; disabled?: boolean; role?: Role }) => patch(`/v1/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e) => toast((e as Error).message, "error"),
  });
  const reset2fa = useMutation({
    mutationFn: (id: string) => del(`/v1/admin/users/${id}/2fa`),
    onSuccess: () => {
      toast("Two-factor authentication turned off", "success");
      return qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  const { create: resetLink, dialog } = useCreateInvite();
  const subtitle = [
    ssoEnabled && `${ssoProvider} accounts are created at their first sign-in and their role follows ${ssoProvider} groups.`,
    localEnabled && "Local accounts join with an invite link; their role is set here.",
    "Each user's addresses, messages, destinations and keys are private.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <PageHeader title="Users" subtitle={subtitle} />
      {localEnabled && <InvitesCard />}
      {users.isLoading && <Spinner />}
      <ErrorText error={users.error ?? resetLink.error} />
      <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
        {users.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate">{u.name ?? u.email}</div>
              <div className="truncate text-xs text-zinc-500">
                {u.email} · {u.auth === "local" ? "local account" : ssoProvider} · last sign-in {timeAgo(u.last_login_at)}
              </div>
            </div>
            {u.auth === "local" ? (
              <select
                className="input w-auto"
                aria-label={`Role of ${u.email}`}
                value={u.role}
                onChange={(e) => updateUser.mutate({ id: u.id, role: e.target.value as Role })}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            ) : (
              <Badge value={u.role} />
            )}
            {u.disabled && <Badge value="disabled" />}
            {u.two_factor && (
              <>
                <Badge value="2FA" />
                <button
                  className="btn-ghost"
                  onClick={() =>
                    confirmAction(`Turn off two-factor authentication for ${u.email}? They can sign in with their password alone.`) &&
                    reset2fa.mutate(u.id)
                  }
                >
                  Reset 2FA
                </button>
              </>
            )}
            {localEnabled && u.auth === "local" && (
              <button
                className="btn-ghost"
                onClick={() =>
                  confirmAction(`Create a password reset link for ${u.email}? Their sessions end when they use it.`) &&
                  resetLink.mutate({ email: u.email, role: u.role })
                }
              >
                Reset password
              </button>
            )}
            {u.id !== me?.id && (
              <button
                className="btn-ghost"
                onClick={() =>
                  (u.disabled || confirmAction(`Disable ${u.email}? They are signed out and their API keys stop working.`)) &&
                  updateUser.mutate({ id: u.id, disabled: !u.disabled })
                }
              >
                {u.disabled ? "Enable" : "Disable"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {dialog}
    </>
  );
}
