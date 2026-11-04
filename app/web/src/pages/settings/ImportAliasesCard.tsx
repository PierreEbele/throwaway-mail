import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import { ErrorText, useToast } from "../../components/ui";
import { useDomains } from "../Addresses";

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
  const active = (domains.data ?? []).filter((d) => d.status === "active");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [domain, setDomain] = useState("");
  const [localPart, setLocalPart] = useState<"keep" | "random">("keep");
  const [category, setCategory] = useState("Imported");
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
          toast(`${r.created} address(es) imported, ${r.skipped} skipped`, "success");
        }
      }, setError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="card mt-4 max-w-xl space-y-3 p-5 text-sm">
      <h2 className="font-semibold">Import from SimpleLogin or addy.io</h2>
      <p className="text-zinc-500">
        Upload the CSV (or JSON) export of your aliases. Nothing is created until you confirm the preview. Mail still goes to the old
        service until you change the address on each site, or move your own domain here.
      </p>
      <input
        type="file"
        aria-label="Export file"
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
            Domain
          </label>
          <select id="imp-domain" className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">Keep each alias's domain (must be a domain here)</option>
            {active.map((d) => (
              <option key={d.id} value={d.name}>
                @{d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="imp-local" className="label">
            Local part
          </label>
          <select id="imp-local" className="input" value={localPart} onChange={(e) => setLocalPart(e.target.value as "keep" | "random")}>
            <option value="keep">Keep the alias's local part</option>
            <option value="random">New random local part</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="imp-cat" className="label">
          Category <span className="font-normal text-zinc-400">(blank = auto)</span>
        </label>
        <input id="imp-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button className="btn-secondary" disabled={!content || busy} onClick={() => run(true)}>
          Preview{fileName ? ` ${fileName}` : ""}
        </button>
        <button className="btn-primary" disabled={!report?.dry_run || !report.created || busy} onClick={() => run(false)}>
          Import {report?.dry_run ? report.created : ""} address(es)
        </button>
        <a className="btn-secondary ml-auto" href="/v1/export/aliases.csv" download>
          Export CSV
        </a>
      </div>
      <ErrorText error={error} />
      {report && (
        <div data-testid="import-report">
          <p>
            {FORMAT_NAMES[report.format] ?? report.format} file, {report.total} alias(es): {report.created}{" "}
            {report.dry_run ? "to create" : "created"}, {report.skipped} skipped.
          </p>
          <div className="mt-2 max-h-72 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="p-1">Source</th>
                  <th>New address</th>
                  <th>Site</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="p-1 font-mono">{r.source}</td>
                    <td className="font-mono">{r.email ?? (r.action === "create" ? "(random)" : "—")}</td>
                    <td>{r.site_name}</td>
                    <td className={r.action === "skip" ? "text-amber-700 dark:text-amber-400" : ""}>
                      {r.action === "skip" ? r.reason : r.status === "paused" ? "create (paused)" : "create"}
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
