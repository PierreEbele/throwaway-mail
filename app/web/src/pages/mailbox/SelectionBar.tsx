import type { Category } from "../../types";

export function SelectionBar({
  count,
  categories,
  archived,
  onClear,
  onAction,
}: {
  count: number;
  categories: Category[];
  archived: boolean;
  onClear: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const btn = "rounded px-2 py-1 hover:bg-blue-100 dark:hover:bg-blue-900/50";
  return (
    <div
      role="toolbar"
      aria-label="Selected addresses"
      className="flex flex-wrap items-center gap-1 border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-950 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-100"
    >
      <span className="mr-1 font-semibold">{count} selected</span>
      <label className="sr-only" htmlFor="bulk-move">
        Move selection to
      </label>
      <select
        id="bulk-move"
        className="input w-auto py-0.5 text-xs"
        value=""
        onChange={(e) => onAction("move", { category_id: e.target.value === "__none" ? null : e.target.value })}
      >
        <option value="" disabled>
          Move to…
        </option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value="__none">No category</option>
      </select>
      <button className={btn} onClick={() => onAction("pin")}>
        Pin
      </button>
      <button className={btn} onClick={() => onAction("unpin")}>
        Unpin
      </button>
      <button className={btn} onClick={() => onAction("read")}>
        Mark read
      </button>
      <button className={btn} onClick={() => onAction(archived ? "unarchive" : "archive")}>
        {archived ? "Restore" : "Archive"}
      </button>
      <button className={`${btn} text-red-700 dark:text-red-300`} onClick={() => onAction("delete")}>
        Delete
      </button>
      <button className={`${btn} ml-auto`} onClick={onClear} aria-label="Clear selection">
        ✕
      </button>
    </div>
  );
}
