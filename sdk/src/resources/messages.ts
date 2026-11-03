import { compact, seg, type HttpClient, type RequestOptions } from "../http.js";
import type { Message } from "../types.js";

export type BulkMessageAction = "read" | "archive" | "unarchive" | "delete";
export type BulkMessageScope = "inbox" | "archived" | "read" | "all";

export class Messages {
  constructor(private http: HttpClient) {}

  async get(id: string, opts?: RequestOptions): Promise<Message> {
    return (await this.http.get<{ message: Message }>(`/v1/messages/${seg(id)}`, undefined, opts)).message;
  }

  async update(id: string, p: { read?: boolean; archived?: boolean }, opts?: RequestOptions): Promise<void> {
    await this.http.patch(`/v1/messages/${seg(id)}`, compact(p), opts);
  }

  markRead(id: string, opts?: RequestOptions) {
    return this.update(id, { read: true }, opts);
  }

  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/messages/${seg(id)}`, opts);
  }

  /** Bulk action on one address's messages: give either `ids` or `scope`. Returns the affected count. */
  async bulk(
    addressId: string,
    action: BulkMessageAction,
    target: { ids: string[] } | { scope: BulkMessageScope },
    opts?: RequestOptions,
  ): Promise<number> {
    const r = await this.http.post<{ affected: number }>(`/v1/addresses/${seg(addressId)}/messages/bulk`, { action, ...target }, opts);
    return r.affected;
  }

  /** Follows the message's List-Unsubscribe header. */
  async unsubscribe(id: string, p: { block?: boolean } = {}, opts?: RequestOptions) {
    return this.http.post<{ done: boolean; error: string | null; url: string | null; mailto: string | null; blocked: boolean }>(
      `/v1/messages/${seg(id)}/unsubscribe`,
      { block: p.block ?? false },
      opts,
    );
  }
}
