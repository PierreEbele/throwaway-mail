import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch } from "../../api";
import type { Domain, User } from "../../types";
import { useToast } from "../../components/ui";
import { useT } from "../../i18n";

/** Settings of the "auto_create" policy: who owns the addresses created on the fly, and their category. */
export function AutoCreatePanel({ d, users }: { d: Domain; users: User[] | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT().domainSetup;
  const [category, setCategory] = useState(d.auto_create_category ?? "");
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/v1/domains/${d.id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast(t.autoSaved, "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <div className="mt-2 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800" data-testid={`autocreate-${d.name}`}>
      <p>
        {t.autoIntro1} <code>…@{d.name}</code> {t.autoIntro2}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor={`ac-user-${d.id}`}>{t.owner}</label>
        <select
          id={`ac-user-${d.id}`}
          className="input w-auto"
          value={d.auto_create_user_id ?? ""}
          onChange={(e) => save.mutate({ auto_create_user_id: e.target.value || null })}
        >
          <option value="">{t.domainOwner}</option>
          {users?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name ?? u.email}
            </option>
          ))}
        </select>
        <label htmlFor={`ac-cat-${d.id}`}>{t.category}</label>
        <input
          id={`ac-cat-${d.id}`}
          className="input w-40"
          placeholder={t.categoryPlaceholder}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <button
          className="btn-secondary"
          disabled={save.isPending || category.trim() === (d.auto_create_category ?? "")}
          onClick={() => save.mutate({ auto_create_category: category.trim() || null })}
        >
          {t.saveCategory}
        </button>
      </div>
    </div>
  );
}
