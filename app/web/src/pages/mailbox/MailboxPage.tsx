import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { AddressDetailPage } from "../address/AddressDetailPage";
import { AddressList } from "./AddressList";
import { useFolder } from "./shared";
import { useT } from "../../i18n";

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
  const t = useT().mailbox;
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
        {t.select}
        <p className="mt-1 text-xs">
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">n</kbd> {t.kNew} ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">/</kbd> {t.kSearch} ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">j</kbd>/
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">k</kbd> {t.kNav}
        </p>
        <p className="mt-1 text-xs">
          {t.kMulti} · <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">1</kbd>–
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">9</kbd> {t.kMove} ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">p</kbd> {t.kPin} ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">a</kbd> {t.kArchive} ·{" "}
          <kbd className="rounded border border-zinc-300 px-1 dark:border-zinc-700">h</kbd> {t.kHide}
        </p>
      </div>
    </div>
  );
}
