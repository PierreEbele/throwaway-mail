import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Invalidates each of the given query keys. */
export function invalidate(qc: QueryClient, ...keys: QueryKey[]) {
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

/** An address changed (status, category, pin, deletion...): lists, the address, its mail, sidebar counts. */
export function invalidateAddress(qc: QueryClient, id: string) {
  invalidate(qc, ["addresses"], ["address", id], ["messages", id], ["categories"], ["stale"]);
}

/** Several addresses changed: every address-related query. */
export function invalidateMailbox(qc: QueryClient) {
  invalidate(qc, ["addresses"], ["address"], ["categories"], ["stale"], ["messages"]);
}

/** A message of `addressId` changed (archived, deleted). */
export function invalidateMessage(qc: QueryClient, id: string, addressId: string) {
  invalidate(qc, ["messages", addressId], ["message", id], ["address", addressId], ["addresses"], ["code", addressId]);
}

/** A new mail arrived on `addressId`. */
export function invalidateNewMail(qc: QueryClient, addressId: string) {
  invalidate(
    qc,
    ["addresses"],
    ["address", addressId],
    ["messages", addressId],
    ["code", addressId],
    ["stats", addressId],
    ["categories"],
    ["digest"],
    ["review"],
    ["review-count"],
  );
}

/** The review queue changed. */
export function invalidateReview(qc: QueryClient) {
  invalidate(qc, ["review"], ["review-count"], ["addresses"]);
}
