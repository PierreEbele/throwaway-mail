import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { del, patch, post } from "../../api";
import type { Category, CategoryColor } from "../../types";
import { ErrorText, Modal, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { COLORS, DOT } from "./shared";

export function CategoryDialog({ open, onClose, category }: { open: boolean; onClose: () => void; category?: Category | null }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState<CategoryColor>("zinc");
  const [hidden, setHidden] = useState(false);
  const [autoMatch, setAutoMatch] = useState("");
  const [retention, setRetention] = useState("");
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (open) {
      setName(category?.name ?? "");
      setColor(category?.color ?? "blue");
      setPinned(category?.pinned ?? false);
      setHidden(category?.hidden ?? false);
      setAutoMatch(category?.auto_match ?? "");
      setRetention(category?.retention_days ? String(category.retention_days) : "");
    }
  }, [open, category]);
  const done = () => {
    invalidate(qc, ["categories"], ["addresses"]);
    onClose();
  };
  const extra = { auto_match: autoMatch.trim() || null, retention_days: retention ? Number(retention) : null };
  const save = useMutation({
    mutationFn: () =>
      category
        ? patch(`/v1/categories/${category.id}`, { name, color, pinned, hidden, ...extra })
        : post("/v1/categories", { name, color, pinned, ...extra }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => del(`/v1/categories/${category!.id}`),
    onSuccess: () => {
      toast(`Category ${category!.name} deleted`, "success");
      nav("/");
      done();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={category ? "Edit category" : "New category"}>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <label htmlFor="cat-name" className="label">
            Name
          </label>
          <input
            id="cat-name"
            className="input"
            required
            maxLength={40}
            placeholder="e.g. Shopping"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <fieldset>
          <legend className="label">Colour</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`size-7 rounded-full ${DOT[c]} ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 ${color === c ? "ring-2 ring-zinc-900 dark:ring-zinc-100" : ""}`}
              />
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top of the sidebar
        </label>
        <div>
          <label htmlFor="cat-auto" className="label">
            Auto-sort keywords
          </label>
          <input
            id="cat-auto"
            className="input"
            maxLength={500}
            placeholder="e.g. shop, store, amazon"
            value={autoMatch}
            onChange={(e) => setAutoMatch(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">
            New addresses whose site name or URL contains one of these words go into this category.
          </p>
        </div>
        <div>
          <label htmlFor="cat-ret" className="label">
            Delete mail after (days)
          </label>
          <input
            id="cat-ret"
            className="input"
            type="number"
            min={1}
            max={3650}
            placeholder="Server default"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">Only shortens the server-wide retention; leave empty to keep the default.</p>
        </div>
        {category && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hide its addresses from the Inbox
          </label>
        )}
        <ErrorText error={save.error ?? remove.error} />
        <div className="flex items-center justify-between gap-2">
          {category ? (
            <button
              type="button"
              className="btn-ghost text-red-600"
              onClick={() =>
                confirmAction(
                  `Delete the category ${category.name}? Its ${category.address_count} address(es) are kept, without a category.`,
                ) && remove.mutate()
              }
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          {category && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() =>
                confirmAction(`Pause every active address in ${category.name}? (Undo from Account → Panic button)`) &&
                post<{ affected: number }>("/v1/panic", { category_id: category.id }).then((r) => {
                  qc.invalidateQueries();
                  toast(`${r.affected} address(es) paused`, "success");
                  onClose();
                })
              }
            >
              Pause all
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" disabled={save.isPending}>
              {category ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
