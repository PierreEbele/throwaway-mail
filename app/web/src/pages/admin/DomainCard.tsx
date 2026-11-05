import type { Domain, User } from "../../types";
import { Badge, confirmAction } from "../../components/ui";
import { timeAgo } from "../../util";
import { POLICIES } from "./AddDomainForm";
import { MailboxPanel } from "./MailboxPanel";
import { AutoCreatePanel } from "./AutoCreatePanel";
import { useT } from "../../i18n";

/** One domain of the admin list: owner, unknown-address policy, previous catch-all, DNS problems and transport details. */
export function DomainCard({
  d,
  users,
  onOwner,
  onPolicy,
  onVerify,
  verifying,
  onRemove,
  onForwardUnknown,
}: {
  d: Domain;
  users: User[] | undefined;
  onOwner: (userId: string) => void;
  onPolicy: (policy: string) => void;
  onVerify: () => void;
  verifying: boolean;
  onRemove: () => void;
  onForwardUnknown: (on: boolean) => void;
}) {
  const t = useT().admin.domains;
  const tc = useT().common;
  return (
    <li className="card p-4" data-testid={`domain-${d.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">{d.name}</span>
          <Badge value={d.status} />
          {d.transport === "imap" && <span className="text-xs text-zinc-500">{t.imapMailbox}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`own-${d.id}`}>
            {t.ownerOf(d.name)}
          </label>
          <select
            id={`own-${d.id}`}
            className="input w-auto"
            value={d.owner?.id ?? ""}
            onChange={(e) => {
              const u = users?.find((x) => x.id === e.target.value);
              if (u && confirmAction(t.confirmOwner(d.name, u.name ?? u.email))) onOwner(u.id);
            }}
          >
            {!d.owner && <option value="">{t.noOwner}</option>}
            {users?.map((u) => (
              <option key={u.id} value={u.id}>
                {t.ownerOption(u.name ?? u.email)}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`pol-${d.id}`}>
            {t.policyOf(d.name)}
          </label>
          <select id={`pol-${d.id}`} className="input w-auto" value={d.unknown_policy} onChange={(e) => onPolicy(e.target.value)}>
            {POLICIES.map((k) => (
              <option key={k} value={k}>
                {t.policyOption(k)}
              </option>
            ))}
          </select>
          {d.transport === "cloudflare" && (
            <button className="btn-secondary" onClick={onVerify} disabled={verifying}>
              {t.recheck}
            </button>
          )}
          <button
            className="btn-ghost text-red-600"
            onClick={() => confirmAction(t.confirmRemove(d.name, d.transport === "imap")) && onRemove()}
          >
            {tc.remove}
          </button>
        </div>
      </div>
      {d.unknown_policy === "auto_create" && <AutoCreatePanel d={d} users={users} />}
      {d.previous_catch_all &&
        (() => {
          const oldFwd = d.previous_catch_all.actions.find((a) => a.type === "forward")?.value?.[0];
          return (
            <div className="mt-2 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
              <p>
                {t.previousCatchAll}{" "}
                <strong>
                  {d.previous_catch_all.actions.map((a) => `${a.type}${a.value ? " → " + a.value.join(", ") : ""}`).join("; ")}
                </strong>
                {t.restoredOnRemove}
              </p>
              {oldFwd && (
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  {d.catchall_forward_to ? (
                    <>
                      {t.stillForwarded(d.catchall_forward_to)}
                      <button
                        className="btn-ghost"
                        onClick={() => confirmAction(t.confirmStopForward(oldFwd, d.unknown_policy)) && onForwardUnknown(false)}
                      >
                        {t.stopForwarding}
                      </button>
                    </>
                  ) : (
                    <>
                      {t.followPolicy(d.unknown_policy)}
                      <button className="btn-ghost" onClick={() => onForwardUnknown(true)}>
                        {t.forwardAgain(oldFwd)}
                      </button>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })()}
      {d.status_detail && (
        <p className={`mt-2 text-sm ${d.status === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-400"}`}>
          {d.status_detail}
        </p>
      )}
      {!!d.dns_missing?.length && (
        <div className="mt-3 overflow-x-auto">
          <p className="mb-1 text-sm font-medium">{t.missingDns}</p>
          <table className="w-full font-mono text-xs">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="pr-4">{t.type}</th>
                <th className="pr-4">{t.name}</th>
                <th className="pr-4">{t.content}</th>
                <th>{t.priority}</th>
              </tr>
            </thead>
            <tbody>
              {d.dns_missing.map((r, i) => (
                <tr key={i}>
                  <td className="pr-4">{r.type}</td>
                  <td className="pr-4">{r.name}</td>
                  <td className="pr-4 break-all">{r.content}</td>
                  <td>{r.priority ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.mailbox ? (
        <MailboxPanel domain={{ ...d, mailbox: d.mailbox }} />
      ) : (
        <p className="mt-2 text-xs text-zinc-500">{t.zone(d.cf_zone_id ?? "—", timeAgo(d.last_checked_at))}</p>
      )}
    </li>
  );
}
