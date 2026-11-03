import { useState } from "react";
import type { Address, CategoryColor } from "../../types";
import { hostOf } from "../../util";

const AVATAR: Record<CategoryColor, string> = {
  zinc: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  green: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  teal: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  pink: "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
};

/** Site logo (served and cached by the server), or a coloured initial as a fallback. */
export function SiteAvatar({ a, color, size = "size-9" }: { a: Address; color: CategoryColor; size?: string }) {
  const host = hostOf(a.site_url, { bare: true });
  const [failed, setFailed] = useState(false);
  if (host && !failed)
    return (
      <span
        className={`grid ${size} shrink-0 place-items-center overflow-hidden rounded-full border border-zinc-200 bg-white dark:border-zinc-700`}
        aria-hidden
      >
        <img src={`/v1/icons/${encodeURIComponent(host)}`} alt="" className="size-5" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-full text-sm font-semibold uppercase ${AVATAR[color]}`} aria-hidden>
      {a.site_name.trim()[0] ?? "?"}
    </span>
  );
}
