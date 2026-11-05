import { useQuery } from "@tanstack/react-query";
import { get } from "../../api";
import { ErrorText, PageHeader, Spinner } from "../../components/ui";
import { timeAgo } from "../../util";
import { msg, useT } from "../../i18n";

type CheckStatus = "ok" | "warn" | "error";

interface Check {
  id: string;
  group: string;
  title: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

interface Diagnostics {
  generated_at: number;
  summary: Record<CheckStatus, number>;
  checks: Check[];
}

const STATUS: Record<CheckStatus, { label: () => string; cls: string; mark: string }> = {
  ok: { label: () => msg().ops.setup.ok, mark: "✓", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300" },
  warn: { label: () => msg().ops.setup.warn, mark: "!", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
  error: { label: () => msg().ops.setup.error, mark: "✗", cls: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300" },
};

/** Admin → Setup check: GET /v1/admin/diagnostics, grouped, with what to do for each warning or error. */
export function SetupCheckPage() {
  const q = useQuery({
    queryKey: ["admin-diagnostics"],
    queryFn: () => get<Diagnostics>("/v1/admin/diagnostics"),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const d = q.data;
  const t = useT().ops.setup;
  const groups = d ? [...new Set(d.checks.map((c) => c.group))] : [];
  return (
    <>
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <button type="button" className="btn-secondary" disabled={q.isFetching} onClick={() => void q.refetch()}>
            {q.isFetching ? t.checking : t.again}
          </button>
        }
      />
      {q.isLoading && <Spinner />}
      <ErrorText error={q.error} />
      {d && (
        <div className="space-y-6">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {d.summary.error ? (
              <span className="font-medium text-red-700 dark:text-red-400">{t.problems(d.summary.error)}</span>
            ) : d.summary.warn ? (
              <span className="font-medium text-amber-700 dark:text-amber-400">{t.warnings(d.summary.warn)}</span>
            ) : (
              <span className="font-medium text-emerald-700 dark:text-emerald-400">{t.good}</span>
            )}{" "}
            {t.summary(d.summary.ok, timeAgo(d.generated_at))}
          </p>
          {groups.map((g) => (
            <section key={g} className="card p-5">
              <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">{t.groups[g] ?? g}</h2>
              <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                {d.checks
                  .filter((c) => c.group === g)
                  .map((c) => (
                    <li key={c.id} className="flex gap-3 py-2.5 text-sm">
                      <span
                        className={`badge h-fit shrink-0 ${STATUS[c.status].cls}`}
                        title={STATUS[c.status].label()}
                        aria-label={STATUS[c.status].label()}
                      >
                        {STATUS[c.status].mark}
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium">{c.title}</p>
                        <p className="break-words text-zinc-600 dark:text-zinc-400">{c.detail}</p>
                        {c.hint && c.status !== "ok" && <p className="mt-1 break-words text-zinc-800 dark:text-zinc-200">→ {c.hint}</p>}
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
