import type { UseQueryResult } from "@tanstack/react-query";
import type { CodeResult } from "../../types";
import { CopyButton, Spinner } from "../../components/ui";
import { useT } from "../../i18n";
import { formatNumber } from "../../util";
import { timeAgo } from "../../util";

/** Latest verification code and links of the address. */
export function CodeCard({ code }: { code: UseQueryResult<CodeResult | null> }) {
  const t = useT().address;
  const tc = useT().common;
  return (
    <section className="card p-5 2xl:col-span-2" aria-labelledby="latest-code">
      <h2 id="latest-code" className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
        {t.latestCode}
      </h2>
      {code.isLoading ? (
        <Spinner />
      ) : code.data?.code ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-mono text-5xl font-bold tracking-[0.2em] select-all" data-testid="latest-code">
              {code.data.code}
            </span>
            <CopyButton text={code.data.code} label={t.copyCode} className="btn-primary" big />
          </div>
          <p className="mt-2 text-sm text-zinc-500">
            {code.data.subject ?? tc.noSubject} · {code.data.from} · {timeAgo(code.data.received_at)} ·{" "}
            {t.confidence(formatNumber(code.data.confidence ?? 0, { style: "percent" }))}
          </p>
          {code.data.alternatives.length > 0 && (
            <p className="mt-1 text-xs text-zinc-500">
              {t.otherCandidates}{" "}
              {code.data.alternatives.map((x) => (
                <code key={x.value} className="mx-1 rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                  {x.value}
                </code>
              ))}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">{code.data ? t.noCodeLatest : t.noCodeYet}</p>
      )}
      {code.data && code.data.links.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">{t.links}</h3>
          <ul className="mt-1 space-y-1">
            {code.data.links.map((l) => (
              <li key={l.url} className="flex items-center gap-2 text-sm">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="truncate text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100"
                  title={l.url}
                >
                  {l.label || l.url}
                </a>
                <CopyButton text={l.url} label={t.copyLink} className="btn-ghost px-2 py-0.5 text-xs" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
