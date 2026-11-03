import { compact, type HttpClient, type RequestOptions } from "../http.js";
import type { Address, Digest, ExportCategory, ExportAddress, ExportData, ImportResult, Leak } from "../types.js";
import { Keys } from "./misc.js";

export class Account {
  readonly keys: Keys;
  constructor(private http: HttpClient) {
    this.keys = new Keys(http);
  }

  /** Summary of the last `days` days (1–90, default 7). */
  digest(p: { days?: number } = {}, opts?: RequestOptions): Promise<Digest> {
    return this.http.get<Digest>("/v1/digest", { days: p.days }, opts);
  }

  /** Leak history grouped by sender domain, newest first. */
  async leaks(opts?: RequestOptions): Promise<Leak[]> {
    return (await this.http.get<{ leaks: Leak[] }>("/v1/leaks", undefined, opts)).leaks;
  }

  /** Rejects future mail from `senderDomain` on every address that leaked to it. */
  async blockLeak(senderDomain: string, opts?: RequestOptions): Promise<number> {
    return (await this.http.post<{ affected: number }>("/v1/leaks/block", { sender_domain: senderDomain }, opts)).affected;
  }

  /** Addresses without mail for `days` days (default 30). */
  async staleAddresses(p: { days?: number } = {}, opts?: RequestOptions): Promise<Address[]> {
    return (await this.http.get<{ addresses: Address[] }>("/v1/stale-addresses", { days: p.days }, opts)).addresses;
  }

  cleanupStale(action: "archive" | "delete" | "keep", ids: string[], p: { days?: number } = {}, opts?: RequestOptions) {
    return this.http.post<{ affected: number; skipped: number }>("/v1/stale-addresses", compact({ action, ids, days: p.days }), opts);
  }

  /** Pauses every address (or one category's); `undo` resumes them. */
  async panic(p: { action?: "pause" | "undo"; categoryId?: string | null } = {}, opts?: RequestOptions): Promise<number> {
    return (
      await this.http.post<{ affected: number }>("/v1/panic", compact({ action: p.action ?? "pause", category_id: p.categoryId }), opts)
    ).affected;
  }

  /** Categories and addresses as JSON (no messages). */
  export(opts?: RequestOptions): Promise<ExportData> {
    return this.http.get<ExportData>("/v1/export", undefined, opts);
  }

  import(data: { categories?: ExportCategory[]; addresses?: ExportAddress[] }, opts?: RequestOptions): Promise<ImportResult> {
    return this.http.post<ImportResult>("/v1/import", { categories: data.categories ?? [], addresses: data.addresses ?? [] }, opts);
  }
}
