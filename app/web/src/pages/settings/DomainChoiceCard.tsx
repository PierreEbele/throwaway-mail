import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch } from "../../api";
import { useAuth } from "../../auth";
import { useToast } from "../../components/ui";
import { timeAgo } from "../../util";

interface Rejection {
  id: string;
  site: string;
  domain: string;
  created_at: number;
}

/** Domain choice for new addresses, the "no mail yet" delay, and the sites that rejected one of the domains. */
export function DomainChoiceCard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const rejections = useQuery({
    queryKey: ["site-rejections"],
    queryFn: () => get<{ rejections: Rejection[] }>("/v1/site-rejections").then((r) => r.rejections),
  });
  const save = (body: Record<string, unknown>) =>
    patch("/v1/auth/me/preferences", body).then(
      () => {
        qc.invalidateQueries({ queryKey: ["me"] });
        toast("Saved", "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  const forget = (id: string) =>
    del(`/v1/site-rejections/${id}`).then(
      () => qc.invalidateQueries({ queryKey: ["site-rejections"] }),
      (e: Error) => toast(e.message, "error"),
    );
  if (!user) return null;
  return (
    <div className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">Domains of new addresses</h2>
      <div>
        <label htmlFor="pref-domain-choice" className="label">
          When no domain is chosen
        </label>
        <select
          id="pref-domain-choice"
          className="input"
          value={user.domain_choice}
          onChange={(e) => save({ domain_choice: e.target.value })}
        >
          <option value="first">Use the first domain</option>
          <option value="random">Pick a random domain</option>
          <option value="rotate">Rotate through the domains</option>
        </select>
        <p className="mt-1 text-xs text-zinc-500">Domains a site is known to reject are always skipped.</p>
      </div>
      <div>
        <label htmlFor="pref-no-mail" className="label">
          Warn when a new address received nothing after (minutes, 0 = never)
        </label>
        <input
          id="pref-no-mail"
          type="number"
          min={0}
          max={1440}
          className="input w-32"
          defaultValue={user.no_mail_warn_minutes}
          onBlur={(e) => Number(e.target.value) !== user.no_mail_warn_minutes && save({ no_mail_warn_minutes: Number(e.target.value) })}
        />
      </div>
      <div>
        <h3 className="font-medium">Sites that rejected a domain</h3>
        {!rejections.data?.length ? (
          <p className="text-zinc-500">None reported. Use "Site rejected it" on an address when a site refuses it.</p>
        ) : (
          <ul className="mt-1 divide-y divide-zinc-200 dark:divide-zinc-800">
            {rejections.data.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-1">
                <span className="flex-1">
                  <strong>{r.site}</strong> rejected <code className="font-mono">@{r.domain}</code>{" "}
                  <span className="text-zinc-500">{timeAgo(r.created_at)}</span>
                </span>
                <button className="btn-secondary px-2 py-0.5 text-xs" onClick={() => forget(r.id)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Admin: which sites reject which domains, all users together. */
export function SiteRejectionsCard() {
  const q = useQuery({
    queryKey: ["admin-site-rejections"],
    queryFn: () =>
      get<{ rejections: Array<{ site: string; domain: string; reports: number; last_at: number }> }>("/v1/admin/site-rejections").then(
        (r) => r.rejections,
      ),
  });
  return (
    <div className="card mt-6 p-5 text-sm" data-testid="site-rejections">
      <h2 className="font-semibold">Sites rejecting a domain</h2>
      <p className="text-zinc-500">Reported by users with "Site rejected it". New addresses for these sites skip the domain.</p>
      {!q.data?.length ? (
        <p className="mt-2 text-zinc-500">No report yet.</p>
      ) : (
        <table className="mt-2 w-full text-left">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1">Site</th>
              <th>Domain</th>
              <th>Reports</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={`${r.site}|${r.domain}`} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="py-1">{r.site}</td>
                <td className="font-mono">@{r.domain}</td>
                <td>{r.reports}</td>
                <td className="text-zinc-500">{timeAgo(r.last_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
