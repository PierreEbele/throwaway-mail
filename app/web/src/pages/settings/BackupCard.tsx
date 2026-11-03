import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api";
import { useToast } from "../../components/ui";
import { decryptJson, encryptJson, isEncrypted } from "../../backupCrypto";

export function BackupCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [result, setResult] = useState<string | null>(null);
  const exportEncrypted = async () => {
    const pass = window.prompt("Passphrase for the export (at least 8 characters, keep it safe: it cannot be recovered)");
    if (!pass) return;
    if (pass.length < 8) return toast("Passphrase too short", "error");
    if (window.prompt("Type the passphrase again") !== pass) return toast("Passphrases do not match", "error");
    try {
      const file = await encryptJson(await get("/v1/export"), pass);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "throwaway-mail-export.encrypted.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const importFile = async (file: File) => {
    try {
      let data = JSON.parse(await file.text());
      if (isEncrypted(data)) {
        const pass = window.prompt("This export is encrypted. Passphrase:");
        if (!pass) return;
        data = await decryptJson<{ categories?: unknown[]; addresses?: unknown[] }>(data, pass);
      }
      const r = await post<{ categories_created: number; addresses_created: number; skipped: Array<{ email: string; reason: string }> }>(
        "/v1/import",
        {
          categories: data.categories ?? [],
          addresses: data.addresses ?? [],
        },
      );
      qc.invalidateQueries();
      setResult(
        `${r.addresses_created} address(es) and ${r.categories_created} categor${r.categories_created === 1 ? "y" : "ies"} imported` +
          (r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map((x) => x.reason))].join(", ")})` : ""),
      );
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="card mt-4 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">Export / import</h2>
      <p className="text-zinc-500">
        Download your addresses and categories as JSON (mails are not included), optionally encrypted with a passphrase in your browser
        (AES-256-GCM), or import such a file. Addresses must be on a domain configured here; existing ones are skipped.
      </p>
      <div className="flex flex-wrap gap-2">
        <a className="btn-secondary" href="/v1/export" download>
          Export JSON
        </a>
        <button className="btn-secondary" onClick={exportEncrypted}>
          Export encrypted…
        </button>
        <label className="btn-secondary cursor-pointer">
          Import JSON…
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0]).finally(() => (e.target.value = ""))}
          />
        </label>
      </div>
      {result && <p role="status">{result}</p>}
    </div>
  );
}
