import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch } from "../../api";
import type { Address } from "../../types";
import { ErrorText, Modal } from "../../components/ui";
import { invalidate } from "../../queries";

export function EditSiteDialog({ address, open, onClose }: { address: Address; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [siteName, setSiteName] = useState(address.site_name);
  const [siteUrl, setSiteUrl] = useState(address.site_url ?? "");
  const [label, setLabel] = useState(address.label ?? "");
  useEffect(() => {
    if (open) {
      setSiteName(address.site_name);
      setSiteUrl(address.site_url ?? "");
      setLabel(address.label ?? "");
    }
  }, [open, address]);
  const save = useMutation({
    mutationFn: () => patch(`/v1/addresses/${address.id}`, { site_name: siteName, site_url: siteUrl, label }),
    onSuccess: () => {
      invalidate(qc, ["address", address.id], ["addresses"]);
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Edit site">
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <label htmlFor="es-name" className="label">
            Site name
          </label>
          <input id="es-name" className="input" required value={siteName} onChange={(e) => setSiteName(e.target.value)} autoFocus />
        </div>
        <div>
          <label htmlFor="es-url" className="label">
            Site URL
          </label>
          <input id="es-url" className="input" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="example.com" />
        </div>
        <div>
          <label htmlFor="es-label" className="label">
            Label / note
          </label>
          <input id="es-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={save.isPending}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
