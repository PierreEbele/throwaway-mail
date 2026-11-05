import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../api";
import type { MessageFull } from "../../types";
import { useToast } from "../../components/ui";
import { useT } from "../../i18n";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";

export function UnsubscribeButton({ m }: { m: MessageFull }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const t = useT().address;
  if (m.unsubscribe!.done_at) return <span>{t.unsubscribed(timeAgo(m.unsubscribe!.done_at))}</span>;
  const run = async (block: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ done: boolean; error: string | null; url: string | null; mailto: string | null }>(
        `/v1/messages/${m.id}/unsubscribe`,
        { block },
      );
      invalidate(qc, ["message", m.id], ["address", m.address_id]);
      if (r.done) toast(block ? t.unsubDoneBlock : t.unsubDone, "success");
      else if (r.url || r.mailto) {
        window.open(r.url ?? r.mailto!, "_blank", "noopener,noreferrer");
        toast(t.unsubFinish, "success");
      } else toast(r.error ?? t.unsubFailed, "error");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex gap-1">
      <button className="btn-secondary px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(false)}>
        {t.unsubscribe}
      </button>
      <button className="btn-secondary px-2 py-0.5 text-xs" disabled={busy} onClick={() => run(true)} title={t.unsubBlockTitle}>
        {t.unsubBlock}
      </button>
    </span>
  );
}
