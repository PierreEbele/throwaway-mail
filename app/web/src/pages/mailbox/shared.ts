import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../api";
import type { Address, Category, CategoryColor, SavedSearch } from "../../types";
import { msg } from "../../i18n";

export const COLORS: CategoryColor[] = ["zinc", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"];
// Full class names so Tailwind keeps them.
export const DOT: Record<CategoryColor, string> = {
  zinc: "bg-zinc-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};

/** MIME type used when dragging an address row onto a sidebar category. */
export const ADDRESS_DRAG_TYPE = "application/x-throwaway-address";
/** MIME type used when dragging a category to reorder the sidebar. */
export const CATEGORY_DRAG_TYPE = "application/x-throwaway-category";

export function useCategories(enabled = true) {
  return useQuery({
    queryKey: ["categories"],
    enabled,
    queryFn: () => get<{ categories: Category[] }>("/v1/categories").then((r) => r.categories),
  });
}

export const STALE_DAYS = 30;
export function useStale(enabled = true) {
  return useQuery({
    queryKey: ["stale"],
    enabled,
    queryFn: () => get<{ addresses: Address[] }>(`/v1/stale-addresses?days=${STALE_DAYS}`).then((r) => r.addresses),
  });
}

export function useSavedSearches(enabled = true) {
  return useQuery({
    queryKey: ["saved-searches"],
    enabled,
    queryFn: () => get<{ searches: SavedSearch[] }>("/v1/saved-searches").then((r) => r.searches),
  });
}

/** Quick filters shown as chips above the list; also what a smart folder stores. */
export const QUICK_FILTERS: Array<{ key: string; value: string; readonly label: string }> = [
  {
    key: "unread",
    value: "true",
    get label() {
      return msg().mailbox.filters.unread;
    },
  },
  {
    key: "has_code",
    value: "true",
    get label() {
      return msg().mailbox.filters.hasCode;
    },
  },
  {
    key: "since_hours",
    value: "24",
    get label() {
      return msg().mailbox.filters.last24;
    },
  },
  {
    key: "leak",
    value: "true",
    get label() {
      return msg().mailbox.filters.leak;
    },
  },
];

/** Folder from `?folder=`: inbox | pinned | archived | none | smart:<id> | <category id>. */
export function useFolder() {
  const [sp] = useSearchParams();
  return sp.get("folder") ?? "inbox";
}
export const folderHref = (folder: string) => (folder === "inbox" ? "/" : `/?folder=${encodeURIComponent(folder)}`);
