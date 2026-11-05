import type { Domain, User } from "../../types";
import { Badge, confirmAction } from "../../components/ui";
import { timeAgo } from "../../util";
import { POLICY_HELP } from "./AddDomainForm";
import { MailboxPanel } from "./MailboxPanel";
import { AutoCreatePanel } from "./AutoCreatePanel";

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
  return (
    <li className="card p-4" data-testid={`domain-${d.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">{d.name}</span>
          <Badge value={d.status} />
          {d.transport === "imap" && <span className="text-xs text-zinc-500">IMAP mailbox</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`own-${d.id}`}>
            Owner of {d.name}
          </label>
          <select
            id={`own-${d.id}`}
            className="input w-auto"
            value={d.owner?.id ?? ""}
            onChange={(e) => {
              const u = users?.find((x) => x.id === e.target.value);
              if (u && confirmAction(`Give ${d.name} to ${u.name ?? u.email}? Its "To sort" box and the mail in it move to them.`))
                onOwner(u.id);
            }}
          >
            {!d.owner && <option value="">no owner</option>}
            {users?.map((u) => (
              <option key={u.id} value={u.id}>
                owner: {u.name ?? u.email}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`pol-${d.id}`}>
            Unknown address policy for {d.name}
          </label>
          <select id={`pol-${d.id}`} className="input w-auto" value={d.unknown_policy} onChange={(e) => onPolicy(e.target.value)}>
            {Object.keys(POLICY_HELP).map((k) => (
              <option key={k} value={k}>
                unknown: {k}
              </option>
            ))}
          </select>
          {d.transport === "cloudflare" && (
            <button className="btn-secondary" onClick={onVerify} disabled={verifying}>
              Re-check
            </button>
          )}
          <button
            className="btn-ghost text-red-600"
            onClick={() =>
              confirmAction(
                `Remove ${d.name}? Only possible when it has no addresses. ${d.transport === "imap" ? "Polling stops; the mailbox is left as it is." : "Cloudflare settings are left untouched."}`,
              ) && onRemove()
            }
          >
            Remove
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
                Catch-all before the app:{" "}
                <strong>
                  {d.previous_catch_all.actions.map((a) => `${a.type}${a.value ? " → " + a.value.join(", ") : ""}`).join("; ")}
                </strong>
                . It is restored if you remove the domain here.
              </p>
              {oldFwd && (
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  {d.catchall_forward_to ? (
                    <>
                      Unknown addresses are still forwarded to {d.catchall_forward_to} and listed under “To sort”.
                      <button
                        className="btn-ghost"
                        onClick={() =>
                          confirmAction(
                            `Stop forwarding unknown addresses to ${oldFwd}? The "${d.unknown_policy}" policy will apply instead.`,
                          ) && onForwardUnknown(false)
                        }
                      >
                        Stop forwarding
                      </button>
                    </>
                  ) : (
                    <>
                      Unknown addresses follow the “{d.unknown_policy}” policy.
                      <button className="btn-ghost" onClick={() => onForwardUnknown(true)}>
                        Forward them to {oldFwd} again
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
          <p className="mb-1 text-sm font-medium">Missing DNS records</p>
          <table className="w-full font-mono text-xs">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="pr-4">Type</th>
                <th className="pr-4">Name</th>
                <th className="pr-4">Content</th>
                <th>Priority</th>
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
        <p className="mt-2 text-xs text-zinc-500">
          Zone {d.cf_zone_id ?? "—"} · last checked {timeAgo(d.last_checked_at)}
        </p>
      )}
    </li>
  );
}
