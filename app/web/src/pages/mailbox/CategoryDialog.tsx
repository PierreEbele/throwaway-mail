import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { del, patch, post } from "../../api";
import type { Category, CategoryColor } from "../../types";
import { ErrorText, Modal, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { COLORS, DOT } from "./shared";
import { useT } from "../../i18n";

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
  const t = useT().menus.category;
  const tc = useT().common;
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
      toast(t.deleted(category!.name), "success");
      nav("/");
      done();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={category ? t.edit : t.create}>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <label htmlFor="cat-name" className="label">
            {t.name}
          </label>
          <input
            id="cat-name"
            className="input"
            required
            maxLength={40}
            placeholder={t.namePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <fieldset>
          <legend className="label">{t.colour}</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={t.colours[c] ?? c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`size-7 rounded-full ${DOT[c]} ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 ${color === c ? "ring-2 ring-zinc-900 dark:ring-zinc-100" : ""}`}
              />
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> {t.pinTop}
        </label>
        <div>
          <label htmlFor="cat-auto" className="label">
            {t.autoSort}
          </label>
          <input
            id="cat-auto"
            className="input"
            maxLength={500}
            placeholder={t.autoPlaceholder}
            value={autoMatch}
            onChange={(e) => setAutoMatch(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">{t.autoHelp}</p>
        </div>
        <div>
          <label htmlFor="cat-ret" className="label">
            {t.retention}
          </label>
          <input
            id="cat-ret"
            className="input"
            type="number"
            min={1}
            max={3650}
            placeholder={t.serverDefault}
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">{t.retentionHelp}</p>
        </div>
        {category && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {t.hide}
          </label>
        )}
        <ErrorText error={save.error ?? remove.error} />
        <div className="flex items-center justify-between gap-2">
          {category ? (
            <button
              type="button"
              className="btn-ghost text-red-600"
              onClick={() => confirmAction(t.confirmDelete(category.name, category.address_count)) && remove.mutate()}
            >
              {tc.delete}
            </button>
          ) : (
            <span />
          )}
          {category && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() =>
                confirmAction(t.confirmPause(category.name)) &&
                post<{ affected: number }>("/v1/panic", { category_id: category.id }).then((r) => {
                  qc.invalidateQueries();
                  toast(t.paused(r.affected), "success");
                  onClose();
                })
              }
            >
              {t.pauseAll}
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              {tc.cancel}
            </button>
            <button className="btn-primary" disabled={save.isPending}>
              {category ? tc.save : t.createBtn}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
