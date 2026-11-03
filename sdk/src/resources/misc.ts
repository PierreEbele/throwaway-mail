import { compact, seg, type HttpClient, type RequestOptions } from "../http.js";
import type { ApiKey, Destination, Directory, NotifyEvent, NotifyKind, NotifyTarget, SmartFolder } from "../types.js";

export class SmartFolders {
  constructor(private http: HttpClient) {}
  async list(opts?: RequestOptions): Promise<SmartFolder[]> {
    return (await this.http.get<{ searches: SmartFolder[] }>("/v1/saved-searches", undefined, opts)).searches;
  }
  /** `params` are `GET /v1/addresses` query parameters in their API (snake_case) form, e.g. `{ has_code: "true" }`. */
  async create(name: string, params: Record<string, string>, opts?: RequestOptions): Promise<SmartFolder> {
    return (await this.http.post<{ search: SmartFolder }>("/v1/saved-searches", { name, params }, opts)).search;
  }
  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/saved-searches/${seg(id)}`, opts);
  }
}

export class Directories {
  constructor(private http: HttpClient) {}
  async list(opts?: RequestOptions): Promise<Directory[]> {
    return (await this.http.get<{ directories: Directory[] }>("/v1/directories", undefined, opts)).directories;
  }
  async create(name: string, opts?: RequestOptions): Promise<Directory> {
    return (await this.http.post<{ directory: Directory }>("/v1/directories", { name }, opts)).directory;
  }
  /** Addresses created through the directory are kept. */
  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/directories/${seg(id)}`, opts);
  }
}

export class Destinations {
  constructor(private http: HttpClient) {}
  async list(opts?: RequestOptions): Promise<Destination[]> {
    return (await this.http.get<{ destinations: Destination[] }>("/v1/destinations", undefined, opts)).destinations;
  }
  async create(email: string, opts?: RequestOptions): Promise<Destination> {
    return (await this.http.post<{ destination: Destination }>("/v1/destinations", { email }, opts)).destination;
  }
  /** Sets or clears (`null`) the PGP public key used to encrypt forwarded mail. */
  async update(id: string, p: { pgpPublicKey?: string | null; pgpHideSubject?: boolean }, opts?: RequestOptions): Promise<Destination> {
    const body = compact({ pgp_public_key: p.pgpPublicKey, pgp_hide_subject: p.pgpHideSubject });
    return (await this.http.patch<{ destination: Destination }>(`/v1/destinations/${seg(id)}`, body, opts)).destination;
  }
  async refresh(id: string, opts?: RequestOptions): Promise<Destination> {
    return (await this.http.post<{ destination: Destination }>(`/v1/destinations/${seg(id)}/refresh`, {}, opts)).destination;
  }
  async resendVerification(id: string, opts?: RequestOptions): Promise<Destination> {
    return (await this.http.post<{ destination: Destination }>(`/v1/destinations/${seg(id)}/resend`, {}, opts)).destination;
  }
  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/destinations/${seg(id)}`, opts);
  }
}

export interface NotifyTargetParams {
  name?: string;
  url?: string;
  token?: string;
  chatId?: string;
  events?: NotifyEvent[];
  enabled?: boolean;
}

const notifyBody = (p: NotifyTargetParams) =>
  compact({ name: p.name, url: p.url, token: p.token, chat_id: p.chatId, events: p.events, enabled: p.enabled });

export class Notifications {
  constructor(private http: HttpClient) {}
  async list(opts?: RequestOptions): Promise<NotifyTarget[]> {
    return (await this.http.get<{ targets: NotifyTarget[] }>("/v1/notify-targets", undefined, opts)).targets;
  }
  async create(p: NotifyTargetParams & { kind: NotifyKind; name: string }, opts?: RequestOptions): Promise<NotifyTarget> {
    const { enabled: _e, ...rest } = p;
    return (await this.http.post<{ target: NotifyTarget }>("/v1/notify-targets", { kind: p.kind, ...notifyBody(rest) }, opts)).target;
  }
  async update(id: string, p: NotifyTargetParams, opts?: RequestOptions): Promise<NotifyTarget> {
    return (await this.http.patch<{ target: NotifyTarget }>(`/v1/notify-targets/${seg(id)}`, notifyBody(p), opts)).target;
  }
  async delete(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/notify-targets/${seg(id)}`, opts);
  }
  /** Sends a test notification; resolves with the server's delivery result. */
  test(id: string, opts?: RequestOptions): Promise<Record<string, unknown>> {
    return this.http.post(`/v1/notify-targets/${seg(id)}/test`, {}, opts);
  }
}

export class Keys {
  constructor(private http: HttpClient) {}
  async list(opts?: RequestOptions): Promise<ApiKey[]> {
    return (await this.http.get<{ keys: ApiKey[] }>("/v1/keys", undefined, opts)).keys;
  }
  /** The secret (`key`) is only returned here, once. */
  async create(name: string, opts?: RequestOptions): Promise<{ key: string; apiKey: ApiKey }> {
    const r = await this.http.post<{ key: string; api_key: ApiKey }>("/v1/keys", { name }, opts);
    return { key: r.key, apiKey: r.api_key };
  }
  async revoke(id: string, opts?: RequestOptions): Promise<void> {
    await this.http.delete(`/v1/keys/${seg(id)}`, opts);
  }
}
