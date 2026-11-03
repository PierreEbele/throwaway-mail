import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { AddressDetailPage } from "../address/AddressDetailPage";
import { AddressList } from "./AddressList";
import { useFolder } from "./shared";

/** List + reading pane. */
export function MailboxPage() {
  const { id } = useParams();
  const folder = useFolder();
  return (
    <div className="flex h-full min-h-0">
      <div
        className={`h-full w-full shrink-0 border-r border-zinc-200 md:w-80 lg:w-96 dark:border-zinc-800 ${id ? "hidden md:block" : ""}`}
      >
        <AddressList folder={folder} activeId={id} />
      </div>
      <div className={`h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto ${id ? "" : "hidden md:block"}`}>
        {id ? (
          <div className="p-4 md:p-6">
            <AddressDetailPage key={id} />
          </div>
        ) : (
          <EmptyReader />
        )}
      </div>
    </div>
  );
}

function EmptyReader(): ReactNode {
  return (
    <div className="grid h-full place-items-center p-8 text-center text-sm text-zinc-500">
      <div>
        <svg
          viewBox="0 0 24 24"
          className="mx-auto mb-3 size-10 text-zinc-300 dark:text-zinc-700"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
        Select an address to read its mail.
        <p className="mt-1 text-xs">
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">n</kbd> new address ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">/</kbd> search ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">j</kbd>/
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">k</kbd> next/previous
        </p>
        <p className="mt-1 text-xs">
          Ctrl/Shift+click to select several · <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">1</kbd>–
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">9</kbd> move to category ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">p</kbd> pin ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">a</kbd> archive ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">h</kbd> hide category
        </p>
      </div>
    </div>
  );
}
