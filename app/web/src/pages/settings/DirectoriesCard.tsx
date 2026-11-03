import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, post } from "../../api";
import { ErrorText, confirmAction, useToast } from "../../components/ui";
import { invalidate } from "../../queries";
import { useDomains } from "../Addresses";

export function DirectoriesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains();
  const list = useQuery({
    queryKey: ["directories"],
    queryFn: () => get<{ directories: Array<{ id: string; name: string }> }>("/v1/directories").then((r) => r.directories),
  });
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => post("/v1/directories", { name }),
    onSuccess: () => {
      invalidate(qc, ["directories"]);
      setName("");
      toast("Directory reserved", "success");
    },
  });
  const domain = domains.data?.find((d) => d.status === "active")?.name ?? "your-domain";
  return (
    <div className="card mt-4 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">On-the-fly addresses</h2>
      <p className="text-zinc-500">
        Reserve a name, then give out{" "}
        <code className="font-mono">
          {list.data?.[0]?.name ?? "name"}.anysite@{domain}
        </code>{" "}
        anywhere, even from a phone or a paper form: the address is created when its first mail arrives (sorted with your category
        keywords).
      </p>
      {(list.data ?? []).map((x) => (
        <div key={x.id} className="flex items-center gap-2">
          <code className="font-mono">
            {x.name}.*@{domain}
          </code>
          <button
            className="btn-ghost ml-auto px-2 py-0.5 text-xs text-red-600"
            onClick={() =>
              confirmAction(`Release ${x.name}? Existing addresses are kept.`) &&
              del(`/v1/directories/${x.id}`).then(() => invalidate(qc, ["directories"]))
            }
          >
            Release
          </button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <label className="sr-only" htmlFor="dir-name">
          Directory name
        </label>
        <input
          id="dir-name"
          className="input"
          placeholder="e.g. dory"
          pattern="[a-z0-9]{3,32}"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          required
        />
        <button className="btn-primary shrink-0" disabled={add.isPending}>
          Reserve
        </button>
      </form>
      <ErrorText error={add.error} />
    </div>
  );
}
