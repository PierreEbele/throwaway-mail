import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import { confirmAction, useToast } from "../../components/ui";
import { useT } from "../../i18n";

export function PanicCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT().settings.panic;
  const run = (action: "pause" | "undo") =>
    post<{ affected: number }>("/v1/panic", { action }).then(
      (r) => {
        qc.invalidateQueries();
        toast(action === "pause" ? t.paused(r.affected) : t.resumed(r.affected), "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  return (
    <div className="card mt-4 max-w-xl space-y-2 border-red-200 p-5 text-sm dark:border-red-900/50">
      <h2 className="font-semibold">{t.title}</h2>
      <p className="text-zinc-500">{t.help}</p>
      <div className="flex gap-2">
        <button className="btn-danger" onClick={() => confirmAction(t.confirm) && run("pause")}>
          {t.pauseAll}
        </button>
        <button className="btn-secondary" onClick={() => run("undo")}>
          {t.undo}
        </button>
      </div>
    </div>
  );
}
