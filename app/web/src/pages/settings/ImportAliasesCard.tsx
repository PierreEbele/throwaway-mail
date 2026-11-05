import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import { ErrorText, useToast } from "../../components/ui";
import { useDomains } from "../Addresses";
import { useT } from "../../i18n";

interface ImportRow {
  source: string;
  email: string | null;
  site_name: string;
  status: "active" | "paused";
  action: "create" | "skip";
  reason?: string;
}
interface ImportReport {
  format: string;
  dry_run: boolean;
  total: number;
  created: number;
  skipped: number;
  rows: ImportRow[];
}

const FORMAT_NAMES: Record<string, string> = { simplelogin: "SimpleLogin", addy: "addy.io", throwaway: "Throwaway Mail" };

/** Upload a SimpleLogin / addy.io export, preview the plan (dry run), then import. */
export function ImportAliasesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const t = useT().addressPrefs.import;
  const active = (domains.data ?? []).filter((d) => d.status === "active");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [domain, setDomain] = useState("");
  const [localPart, setLocalPart] = useState<"keep" | "random">("keep");
  const [category, setCategory] = useState(t.defaultCategory);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (dry_run: boolean) => {
    setBusy(true);
    setError(null);
    post<ImportReport>("/v1/import/aliases", {
      content,
      domain: domain || undefined,
      local_part: localPart,
      category: category.trim() || undefined,
      dry_run,
    })
      .then((r) => {
        setReport(r);
        if (!dry_run) {
          qc.invalidateQueries();
          toast(t.done(r.created, r.skipped), "success");
        }
      }, setError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">{t.title}</h2>
      <p className="text-zinc-500">{t.help}</p>
      <input
        type="file"
        aria-label={t.file}
        accept=".csv,.json,text/csv,application/json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          setReport(null);
          if (!f) return;
          setFileName(f.name);
          f.text().then(setContent);
        }}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="imp-domain" className="label">
            {t.domain}
          </label>
          <select id="imp-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">{t.keepDomain}</option>
            {active.map((d) => (
              <option key={d.id} value={d.name}>
                @{d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="imp-local" className="label">
            {t.localPart}
          </label>
          <select id="imp-local" className="input" value={localPart} onChange={(e) => setLocalPart(e.target.value as "keep" | "random")}>
            <option value="keep">{t.keepLocal}</option>
            <option value="random">{t.randomLocal}</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="imp-cat" className="label">
          {t.category} <span className="font-normal text-zinc-400">{t.blankAuto}</span>
        </label>
        <input id="imp-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button className="btn-secondary" disabled={!content || busy} onClick={() => run(true)}>
          {t.preview}
          {fileName ? ` ${fileName}` : ""}
        </button>
        <button className="btn-primary" disabled={!report?.dry_run || !report.created || busy} onClick={() => run(false)}>
          {t.importN(report?.dry_run ? report.created : "")}
        </button>
        <a className="btn-secondary ml-auto" href="/v1/export/aliases.csv" download>
          {t.exportCsv}
        </a>
      </div>
      <ErrorText error={error} />
      {report && (
        <div data-testid="import-report">
          <p>{t.summary(FORMAT_NAMES[report.format] ?? report.format, report.total, report.created, report.dry_run, report.skipped)}</p>
          <div className="mt-2 max-h-72 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="p-1">{t.source}</th>
                  <th>{t.newAddress}</th>
                  <th>{t.site}</th>
                  <th>{t.result}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="p-1 font-mono">{r.source}</td>
                    <td className="font-mono">{r.email ?? (r.action === "create" ? t.random : "—")}</td>
                    <td>{r.site_name}</td>
                    <td className={r.action === "skip" ? "text-amber-700 dark:text-amber-400" : ""}>
                      {r.action === "skip" ? r.reason : r.status === "paused" ? t.createPaused : t.create}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
