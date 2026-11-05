import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { Address } from "../../types";
import { ErrorText, Modal, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { STALE_DAYS } from "./shared";
import { useT } from "../../i18n";

/** Addresses that never received mail. */
export function StaleDialog({ open, onClose, items }: { open: boolean; onClose: () => void; items: Address[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const t = useT().mailbox;
  useEffect(() => {
    if (open) setChecked(new Set(items.map((a) => a.id)));
  }, [open, items]);
  const act = useMutation({
    mutationFn: (action: "archive" | "delete" | "keep") =>
      post<{ affected: number }>("/v1/stale-addresses", { action, ids: [...checked], days: STALE_DAYS }).then((r) => ({ ...r, action })),
    onSuccess: (r) => {
      invalidate(qc, ["stale"], ["addresses"], ["categories"]);
      toast(t.staleDone(r.affected, r.action), "success");
      onClose();
    },
  });
  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Modal open={open} onClose={onClose} title={t.staleTitle} wide>
      <p className="mb-3 text-sm text-zinc-500">{t.staleHelp(STALE_DAYS)}</p>
      <ul className="max-h-80 divide-y divide-zinc-200 overflow-auto rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((a) => (
          <li key={a.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              <input type="checkbox" checked={checked.has(a.id)} onChange={() => toggle(a.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.site_name}</span>
                <span className="block truncate font-mono text-xs text-zinc-500">{a.email}</span>
              </span>
              <span className="shrink-0 text-xs text-zinc-500">{t.created(timeAgo(a.created_at))}</span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorText error={act.error} />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" disabled={!checked.size || act.isPending} onClick={() => act.mutate("keep")} title={t.keepTitle}>
          {t.keep}
        </button>
        <button className="btn-secondary" disabled={!checked.size || act.isPending} onClick={() => act.mutate("archive")}>
          {t.archiveN(checked.size)}
        </button>
        <button
          className="btn-danger"
          disabled={!checked.size || act.isPending}
          onClick={() => confirmAction(t.confirmDeleteN(checked.size)) && act.mutate("delete")}
        >
          {t.deleteN(checked.size)}
        </button>
      </div>
    </Modal>
  );
}
