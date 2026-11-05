import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api";
import { useToast } from "../../components/ui";
import { decryptJson, encryptJson, isEncrypted } from "../../backupCrypto";
import { useT } from "../../i18n";

export function BackupCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [result, setResult] = useState<string | null>(null);
  const t = useT().settings.backup;
  const exportEncrypted = async () => {
    const pass = window.prompt(t.passPrompt);
    if (!pass) return;
    if (pass.length < 8) return toast(t.tooShort, "error");
    if (window.prompt(t.again) !== pass) return toast(t.mismatch, "error");
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
        const pass = window.prompt(t.encryptedPrompt);
        if (!pass) return;
        // backupCrypto stays free of UI code (it is unit-tested in Node): translate its error here.
        data = await decryptJson<{ categories?: unknown[]; addresses?: unknown[] }>(data, pass).catch(() => {
          throw new Error(t.wrongPassphrase);
        });
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
        t.imported(r.addresses_created, r.categories_created) +
          (r.skipped.length ? t.skipped(r.skipped.length, [...new Set(r.skipped.map((x) => x.reason))].join(", ")) : ""),
      );
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="card mt-4 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">{t.title}</h2>
      <p className="text-zinc-500">{t.help}</p>
      <div className="flex flex-wrap gap-2">
        <a className="btn-secondary" href="/v1/export" download>
          {t.exportJson}
        </a>
        <button className="btn-secondary" onClick={exportEncrypted}>
          {t.exportEncrypted}
        </button>
        <label className="btn-secondary cursor-pointer">
          {t.importJson}
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
