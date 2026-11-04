import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch } from "../../api";
import type { Domain, User } from "../../types";
import { useToast } from "../../components/ui";

/** Settings of the "auto_create" policy: who owns the addresses created on the fly, and their category. */
export function AutoCreatePanel({ d, users }: { d: Domain; users: User[] | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [category, setCategory] = useState(d.auto_create_category ?? "");
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/v1/domains/${d.id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast("Auto-create settings saved", "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <div className="mt-2 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800" data-testid={`autocreate-${d.name}`}>
      <p>
        Catch-all auto-create: mail to any unknown <code>…@{d.name}</code> creates that address on the fly instead of being rejected.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor={`ac-user-${d.id}`}>Owner</label>
        <select
          id={`ac-user-${d.id}`}
          className="input w-auto"
          value={d.auto_create_user_id ?? ""}
          onChange={(e) => save.mutate({ auto_create_user_id: e.target.value || null })}
        >
          <option value="">Domain owner</option>
          {users?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name ?? u.email}
            </option>
          ))}
        </select>
        <label htmlFor={`ac-cat-${d.id}`}>Category</label>
        <input
          id={`ac-cat-${d.id}`}
          className="input w-40"
          placeholder="auto (from sender)"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <button
          className="btn-secondary"
          disabled={save.isPending || category.trim() === (d.auto_create_category ?? "")}
          onClick={() => save.mutate({ auto_create_category: category.trim() || null })}
        >
          Save category
        </button>
      </div>
    </div>
  );
}
