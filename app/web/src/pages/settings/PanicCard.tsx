import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import { confirmAction, useToast } from "../../components/ui";

export function PanicCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const run = (action: "pause" | "undo") =>
    post<{ affected: number }>("/v1/panic", { action }).then(
      (r) => {
        qc.invalidateQueries();
        toast(action === "pause" ? `${r.affected} address(es) paused` : `${r.affected} address(es) resumed`, "success");
      },
      (e: Error) => toast(e.message, "error"),
    );
  return (
    <div className="card mt-4 max-w-xl space-y-2 border-red-200 p-5 text-sm dark:border-red-900/50">
      <h2 className="font-semibold">Panic button</h2>
      <p className="text-zinc-500">
        Pause every active address at once (all mail rejected), e.g. after a breach. Undo resumes exactly the addresses it paused.
      </p>
      <div className="flex gap-2">
        <button className="btn-danger" onClick={() => confirmAction("Pause ALL your active addresses now?") && run("pause")}>
          Pause everything
        </button>
        <button className="btn-secondary" onClick={() => run("undo")}>
          Undo
        </button>
      </div>
    </div>
  );
}
