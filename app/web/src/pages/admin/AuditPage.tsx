import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../api";
import type { AuditEntry, User } from "../../types";
import { ErrorText, PageHeader, Spinner } from "../../components/ui";
import { formatNumber, fullDate } from "../../util";
import { useT } from "../../i18n";

const AUDIT_PAGE = 50;
const AUDIT_GROUPS = ["auth.", "user.", "invite.", "domain.", "destination."];

export function AuditPage() {
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [offset, setOffset] = useState(0);
  const t = useT().admin.audit;
  const usersQ = useQuery({ queryKey: ["admin-users"], queryFn: () => get<{ users: User[] }>("/v1/admin/users").then((r) => r.users) });
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE), offset: String(offset) });
  if (action) params.set("action", action);
  if (userId) params.set("user_id", userId);
  const log = useQuery({
    queryKey: ["audit", action, userId, offset],
    queryFn: () => get<{ entries: AuditEntry[]; total: number; actions: string[] }>(`/v1/admin/audit?${params}`),
    placeholderData: (prev) => prev,
  });
  const total = log.data?.total ?? 0;
  const known = log.data?.actions ?? [];
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <select
          className="input w-auto"
          aria-label={t.filterAction}
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">{t.allActions}</option>
          <optgroup label={t.groups}>
            {AUDIT_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}*
              </option>
            ))}
          </optgroup>
          <optgroup label={t.actions}>
            {known.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </optgroup>
        </select>
        <select
          className="input w-auto"
          aria-label={t.filterUser}
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">{t.allUsers}</option>
          {usersQ.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>
        <span className="ml-auto text-zinc-500">
          {total ? t.range(formatNumber(offset + 1), formatNumber(Math.min(offset + AUDIT_PAGE, total)), formatNumber(total)) : t.none}
        </span>
        <button className="btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE))}>
          {t.newer}
        </button>
        <button className="btn-ghost" disabled={offset + AUDIT_PAGE >= total} onClick={() => setOffset(offset + AUDIT_PAGE)}>
          {t.older}
        </button>
      </div>
      {log.isLoading && <Spinner />}
      <ErrorText error={log.error} />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500 uppercase">
            <tr>
              <th className="px-4 py-2">{t.when}</th>
              <th className="px-4 py-2">{t.action}</th>
              <th className="px-4 py-2">{t.by}</th>
              <th className="px-4 py-2">{t.target}</th>
              <th className="px-4 py-2">{t.details}</th>
              <th className="px-4 py-2">{t.ip}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {log.data?.entries.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2 whitespace-nowrap">{fullDate(e.created_at)}</td>
                <td className="px-4 py-2 font-mono">{e.action}</td>
                <td className="px-4 py-2 text-xs">{e.user_email ?? (e.user_id ? e.user_id : "—")}</td>
                <td className="px-4 py-2 font-mono text-xs">{e.target}</td>
                <td className="px-4 py-2 font-mono text-xs break-all">{e.meta ? JSON.stringify(e.meta) : ""}</td>
                <td className="px-4 py-2 text-xs">{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
