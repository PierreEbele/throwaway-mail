import { ThrowawayMailError } from "../errors.js";
import { compact, seg, type HttpClient, type RequestOptions } from "../http.js";
import type { Address, AddressStats, AddressStatus, CodeResult, MessageSummary } from "../types.js";

export interface CreateAddressParams {
  /** Site name shown in the UI. Required unless `site` is given. */
  siteName?: string;
  /** Shorthand: used as `siteName`, and as `siteUrl` when it looks like a host name (contains a dot). */
  site?: string;
  siteUrl?: string;
  domain?: string;
  localPart?: string;
  label?: string;
  forward?: boolean;
  destinationId?: string;
  categoryId?: string | null;
  /** Category name (case-insensitive), instead of `categoryId`. */
  category?: string;
  /** Create `category` if it does not exist yet. */
  createCategory?: boolean;
  /** Epoch ms or ISO date; `null` for no expiry. */
  expiresAt?: number | string | null;
  expiresInDays?: number;
  /** Pause the address automatically after this many mails. */
  maxMessages?: number | null;
}

export interface UpdateAddressParams {
  siteName?: string;
  siteUrl?: string;
  label?: string | null;
  forwardEnabled?: boolean;
  destinationId?: string | null;
  /** Replaces the list of additional destinations. */
  extraDestinationIds?: string[];
  status?: AddressStatus;
  expiresAt?: number | string | null;
  categoryId?: string | null;
  category?: string;
  createCategory?: boolean;
  pinned?: boolean;
  blockPromos?: boolean;
  siteLock?: boolean;
  maxMessages?: number | null;
  burnAfterCode?: boolean;
  /** Reverse-alias replies; refused when the domain has no outbound SMTP. */
  repliesEnabled?: boolean;
}

export interface SendMailParams {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text: string;
  html?: string;
  /** Display name shown next to the alias. */
  fromName?: string;
  /** Message-ID of the mail being answered (sets In-Reply-To and References). */
  inReplyTo?: string;
}

export interface SentMail {
  address_id: string;
  from: string;
  /** Real recipients (reverse addresses resolved to the contacts they stand for). */
  to: string[];
  message_id: string;
  via: "mailbox" | "relay";
}

export interface ListAddressesParams {
  site?: string;
  domain?: string;
  status?: AddressStatus | "all";
  q?: string;
  /** Category id, or `"none"` for uncategorised addresses. */
  category?: string;
  pinned?: boolean;
  unread?: boolean;
  hasCode?: boolean;
  /** Only addresses that received mail in the last N hours. */
  sinceHours?: number;
  leak?: boolean;
  hideHidden?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListMessagesParams {
  limit?: number;
  /** Only messages received before this epoch-ms timestamp (pagination). */
  before?: number;
  archived?: boolean | "all";
}

export type BulkAddressAction = "move" | "pin" | "unpin" | "archive" | "unarchive" | "pause" | "resume" | "delete" | "read";
export type SenderAction = "block" | "unblock" | "trust" | "untrust" | "dismiss";
export type Since = number | string | Date;

export interface GetCodeParams extends RequestOptions {
  /** Seconds the server may hold the request open (0–60). */
  wait?: number;
  /** Only consider mail after this point: epoch ms, ISO date, Date, or a message id. */
  since?: Since;
  /** `"code"` ignores mails that only contain a verification link. Default `"any"`. */
  require?: "code" | "any";
}

export interface WaitForCodeOptions {
  /** Overall deadline. Default 120000 ms. */
  timeoutMs?: number;
  since?: Since;
  require?: "code" | "any";
  signal?: AbortSignal;
}

const flag = (v: boolean | undefined) => (v === undefined ? undefined : String(v));
const onlyTrue = (v: boolean | undefined) => (v ? "true" : undefined);
const sinceParam = (s: Since | undefined) => (s instanceof Date ? s.getTime() : s);

function addressBody(p: CreateAddressParams | UpdateAddressParams) {
  return {
    site_url: p.siteUrl,
    label: p.label,
    destination_id: p.destinationId,
    category_id: p.categoryId,
    category: p.category,
    create_category: p.createCategory,
    expires_at: p.expiresAt,
    max_messages: p.maxMessages,
  };
}

export class Addresses {
  constructor(private http: HttpClient) {}

  async create(p: CreateAddressParams, opts?: RequestOptions): Promise<Address> {
    const siteName = p.siteName ?? p.site;
    if (!siteName) throw new TypeError("siteName (or site) is required");
    const siteUrl = p.siteUrl ?? (p.site && p.site.includes(".") ? p.site : undefined);
    const body = compact({
      ...addressBody(p),
      site_name: siteName,
      site_url: siteUrl,
      domain: p.domain,
      local_part: p.localPart,
      forward: p.forward,
      expires_in_days: p.expiresInDays,
    });
    return (await this.http.post<{ address: Address }>("/v1/addresses", body, opts)).address;
  }

  async list(p: ListAddressesParams = {}, opts?: RequestOptions): Promise<Address[]> {
    const query = {
      site: p.site,
      domain: p.domain,
      status: p.status,
      q: p.q,
      category: p.category,
      pinned: flag(p.pinned),
      unread: onlyTrue(p.unread),
      has_code: onlyTrue(p.hasCode),
      since_hours: p.sinceHours,
      leak: onlyTrue(p.leak),
      hide_hidden: flag(p.hideHidden),
      limit: p.limit,
      offset: p.offset,
    };
    return (await this.http.get<{ addresses: Address[] }>("/v1/addresses", query, opts)).addresses;
  }

  async get(id: string, opts?: RequestOptions): Promise<Address> {
    return (await this.http.get<{ address: Address }>(`/v1/addresses/${seg(id)}`, undefined, opts)).address;
  }

  async update(id: string, p: UpdateAddressParams, opts?: RequestOptions): Promise<Address> {
    const body = compact({
      ...addressBody(p),
      site_name: p.siteName,
      forward_enabled: p.forwardEnabled,
      extra_destination_ids: p.extraDestinationIds,
      status: p.status,
      pinned: p.pinned,
      block_promos: p.blockPromos,
      site_lock: p.siteLock,
      burn_after_code: p.burnAfterCode,
      replies_enabled: p.repliesEnabled,
    });
    return (await this.http.patch<{ address: Address }>(`/v1/addresses/${seg(id)}`, body, opts)).address;
  }

  /**
   * Sends a new mail from this address. Recipients become reverse-alias contacts, so their answers come back
   * through the address. Fails with 403 (not allowed), 429 (hourly limit), 502 (refused by the outbound server)
   * or 503 (no outbound server).
   */
  async send(id: string, p: SendMailParams, opts?: RequestOptions): Promise<SentMail> {
    const body = compact({
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      text: p.text,
      html: p.html,
      from_name: p.fromName,
      in_reply_to: p.inReplyTo,
    });
    return (await this.http.post<{ sent: SentMail }>(`/v1/addresses/${seg(id)}/send`, body, opts)).sent;
  }

  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/addresses/${seg(id)}`, opts);
  }

  async messages(id: string, p: ListMessagesParams = {}, opts?: RequestOptions): Promise<MessageSummary[]> {
    const query = { limit: p.limit, before: p.before, archived: p.archived === undefined ? undefined : String(p.archived) };
    return (await this.http.get<{ messages: MessageSummary[] }>(`/v1/addresses/${seg(id)}/messages`, query, opts)).messages;
  }

  /** Applies an action to many addresses at once. `categoryId` is used by `move` (`null` = uncategorised). */
  async bulk(ids: string[], action: BulkAddressAction, p: { categoryId?: string | null } = {}, opts?: RequestOptions): Promise<number> {
    const body = compact({ ids, action, category_id: p.categoryId });
    return (await this.http.post<{ affected: number }>("/v1/addresses/bulk", body, opts)).affected;
  }

  /** Moves addresses to a category (`null` = uncategorised). */
  move(ids: string[], categoryId: string | null, opts?: RequestOptions): Promise<number> {
    return this.bulk(ids, "move", { categoryId }, opts);
  }

  /** Creates a fresh address with the same settings; returns the new one. */
  async replace(id: string, p: { archiveOld?: boolean } = {}, opts?: RequestOptions): Promise<{ address: Address; replacedId: string }> {
    const r = await this.http.post<{ address: Address; replaced_id: string }>(
      `/v1/addresses/${seg(id)}/replace`,
      { archive_old: p.archiveOld ?? false },
      opts,
    );
    return { address: r.address, replacedId: r.replaced_id };
  }

  /** Extends the expiry by `days` from now; `null` removes the expiry. */
  async extend(id: string, days: number | null, opts?: RequestOptions): Promise<Address> {
    return (await this.http.post<{ address: Address }>(`/v1/addresses/${seg(id)}/extend`, { days }, opts)).address;
  }

  async senders(id: string, action: SenderAction, sender?: string, opts?: RequestOptions): Promise<Address> {
    return (await this.http.post<{ address: Address }>(`/v1/addresses/${seg(id)}/senders`, compact({ action, sender }), opts)).address;
  }

  /** Enables or disables the JSON feed (`feed_token` on the returned address). */
  async setFeed(id: string, enabled: boolean, opts?: RequestOptions): Promise<Address> {
    return (await this.http.post<{ address: Address }>(`/v1/addresses/${seg(id)}/feed`, { enabled }, opts)).address;
  }

  stats(id: string, opts?: RequestOptions): Promise<AddressStats> {
    return this.http.get<AddressStats>(`/v1/addresses/${seg(id)}/stats`, undefined, opts);
  }

  /** Single call to the long-poll endpoint. Resolves `null` when nothing arrived within `wait`. */
  async getCode(id: string, p: GetCodeParams = {}): Promise<CodeResult | null> {
    const wait = p.wait ?? 0;
    const query = { wait, since: sinceParam(p.since), require: p.require };
    // The server holds the request for `wait` seconds, so the HTTP timeout must cover it.
    const timeoutMs = p.timeoutMs ?? (wait > 0 ? wait * 1000 + 15_000 : undefined);
    const r = await this.http.get<CodeResult | undefined>(`/v1/addresses/${seg(id)}/code`, query, { signal: p.signal, timeoutMs });
    return r ?? null;
  }

  /**
   * Waits until a code (or, with `require: "any"`, a verification link) arrives, by repeating the
   * long-poll until `timeoutMs` elapses. Throws `ThrowawayMailError` with code `timeout` otherwise.
   * Pass `since` (e.g. `Date.now()` before triggering the sign-up) to ignore older mail.
   */
  async waitForCode(id: string, o: WaitForCodeOptions = {}): Promise<CodeResult> {
    const timeoutMs = o.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (o.signal?.aborted) throw new ThrowawayMailError(0, "aborted", "waitForCode aborted");
      const left = deadline - Date.now();
      const wait = Math.max(0, Math.min(60, Math.floor(left / 1000)));
      const r = await this.getCode(id, { wait, since: o.since, require: o.require, signal: o.signal });
      if (r) return r;
      if (Date.now() >= deadline || wait === 0) {
        if (Date.now() < deadline) await sleep(Math.min(500, deadline - Date.now()), o.signal);
        else throw new ThrowawayMailError(0, "timeout", `No code arrived within ${timeoutMs} ms`);
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
