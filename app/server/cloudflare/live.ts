import type { CatchAllRule, CloudflareClient, DestinationInfo, DnsRecord, TokenInfo, ZoneInfo } from "./index.js";
import { CloudflareError } from "./index.js";

const API = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

export class LiveCloudflareClient implements CloudflareClient {
  readonly mode = "live" as const;
  constructor(
    private token: string,
    private accountId: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(API + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new CloudflareError(`Cloudflare API unreachable: ${(e as Error).message}`, 502);
    }
    let json: CfEnvelope<T> | null = null;
    try {
      json = (await res.json()) as CfEnvelope<T>;
    } catch {
      /* non-JSON */
    }
    if (!res.ok || !json?.success) {
      const err = json?.errors?.[0];
      const msg = err ? `${err.message} (code ${err.code})` : `HTTP ${res.status}`;
      throw new CloudflareError(
        `Cloudflare API error on ${method} ${path.replace(/\/accounts\/[^/]+/, "/accounts/…")}: ${msg}`,
        res.status,
        err?.code,
      );
    }
    return json.result;
  }

  async verifyToken(): Promise<TokenInfo> {
    type Verify = { status: string; expires_on?: string | null };
    let r: Verify;
    try {
      r = await this.call<Verify>("GET", "/user/tokens/verify");
    } catch (e) {
      // Account-owned tokens are only known to the account endpoint; user tokens answer "Invalid API Token" there.
      if (!(e instanceof CloudflareError && e.cfCode === 1000 && this.accountId)) throw e;
      r = await this.call<Verify>("GET", `/accounts/${this.accountId}/tokens/verify`);
    }
    return { status: r.status, expiresOn: r.expires_on ?? null };
  }

  async emailRoutingEnabled(zoneId: string): Promise<boolean> {
    const r = await this.call<{ enabled: boolean }>("GET", `/zones/${zoneId}/email/routing`);
    return !!r.enabled;
  }

  async workerExists(name: string): Promise<boolean | null> {
    try {
      const scripts = await this.call<Array<{ id: string }>>("GET", `/accounts/${this.accountId}/workers/scripts`);
      return scripts.some((s) => s.id === name);
    } catch (e) {
      if (e instanceof CloudflareError && (e.status === 403 || e.cfCode === 10000)) return null;
      throw e;
    }
  }

  async findZone(domain: string): Promise<ZoneInfo | null> {
    // Exact zone first, then parent zones (sub-domain routing).
    const labels = domain.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const zones = await this.call<Array<{ id: string; name: string; status: string }>>("GET", `/zones?name=${encodeURIComponent(name)}`);
      if (zones[0]) return { id: zones[0].id, name: zones[0].name, status: zones[0].status };
    }
    return null;
  }

  async enableEmailRouting(zoneId: string, domain: string): Promise<void> {
    const settings = await this.call<{ enabled: boolean; status?: string }>("GET", `/zones/${zoneId}/email/routing`);
    if (settings.enabled) return;
    try {
      await this.call("POST", `/zones/${zoneId}/email/routing/dns`, { name: domain });
    } catch (e) {
      if (e instanceof CloudflareError && (e.status === 404 || e.status === 405)) {
        await this.call("POST", `/zones/${zoneId}/email/routing/enable`, {});
      } else throw e;
    }
  }

  async setCatchAllToWorker(zoneId: string, workerName: string): Promise<void> {
    await this.setCatchAll(zoneId, { enabled: true, actions: [{ type: "worker", value: [workerName] }] }, "Throwaway Mail catch-all");
  }

  async getCatchAll(zoneId: string): Promise<CatchAllRule | null> {
    try {
      const r = await this.call<{ enabled?: boolean; actions?: Array<{ type: string; value?: string[] }> }>(
        "GET",
        `/zones/${zoneId}/email/routing/rules/catch_all`,
      );
      if (!r) return null;
      return { enabled: !!r.enabled, actions: r.actions ?? [] };
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 404) return null;
      throw e;
    }
  }

  async setCatchAll(zoneId: string, rule: CatchAllRule, name = "Catch-all"): Promise<void> {
    await this.call("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      name,
      enabled: rule.enabled,
      matchers: [{ type: "all" }],
      actions: rule.actions,
    });
  }

  async missingDnsRecords(zoneId: string, domain: string, zoneName: string): Promise<DnsRecord[]> {
    // The `subdomain` parameter is only accepted for a real sub-domain of the zone, never for the apex.
    const q = domain !== zoneName ? `?subdomain=${encodeURIComponent(domain)}` : "";
    const res = await this.call<unknown>("GET", `/zones/${zoneId}/email/routing/dns${q}`);
    // Newer API: { errors: [{ code, missing: {type,name,content,priority} }], record: [...] }; older API: array of required records.
    if (res && typeof res === "object" && !Array.isArray(res) && "errors" in res) {
      const errs = (res as { errors?: Array<{ missing?: DnsRecord }> }).errors ?? [];
      return errs.map((e) => e.missing).filter((m): m is DnsRecord => !!m);
    }
    const required = (Array.isArray(res) ? res : ((res as { record?: DnsRecord[] })?.record ?? [])) as DnsRecord[];
    // Long TXT values (DKIM) are stored as several quoted chunks: "abc" "def" == "abcdef".
    const norm = (v: string) => v.trim().replace(/"\s*"/g, "").replace(/^"|"$/g, "").replace(/\.$/, "").toLowerCase();
    const missing: DnsRecord[] = [];
    // Look each record up by its own name (e.g. the DKIM record lives on cf2024-1._domainkey.<domain>).
    const cache = new Map<string, DnsRecord[]>();
    for (const r of required) {
      const key = `${r.type} ${r.name}`;
      if (!cache.has(key)) {
        cache.set(
          key,
          await this.call<DnsRecord[]>(
            "GET",
            `/zones/${zoneId}/dns_records?per_page=100&type=${encodeURIComponent(r.type)}&name=${encodeURIComponent(r.name)}`,
          ),
        );
      }
      if (!cache.get(key)!.some((e) => norm(e.content) === norm(r.content))) missing.push(r);
    }
    return missing;
  }

  private toDest(r: { id?: string; tag?: string; email: string; verified: string | null }): DestinationInfo {
    return { id: (r.id ?? r.tag)!, email: r.email, verified: r.verified ?? null };
  }

  async createDestination(email: string): Promise<DestinationInfo> {
    try {
      const r = await this.call<{ id?: string; tag?: string; email: string; verified: string | null }>(
        "POST",
        `/accounts/${this.accountId}/email/routing/addresses`,
        { email },
      );
      return this.toDest(r);
    } catch (e) {
      // Already exists at account level (e.g. another user added it): reuse it.
      const existing = await this.findDestinationByEmail(email).catch(() => null);
      if (existing) return existing;
      throw e;
    }
  }

  async getDestination(id: string): Promise<DestinationInfo | null> {
    try {
      return this.toDest(await this.call("GET", `/accounts/${this.accountId}/email/routing/addresses/${id}`));
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 404) return null;
      throw e;
    }
  }

  async findDestinationByEmail(email: string): Promise<DestinationInfo | null> {
    for (let page = 1; page <= 20; page++) {
      const list = await this.call<Array<{ id?: string; tag?: string; email: string; verified: string | null }>>(
        "GET",
        `/accounts/${this.accountId}/email/routing/addresses?per_page=50&page=${page}`,
      );
      const hit = list.find((d) => d.email.toLowerCase() === email.toLowerCase());
      if (hit) return this.toDest(hit);
      if (list.length < 50) break;
    }
    return null;
  }

  async deleteDestination(id: string): Promise<void> {
    try {
      await this.call("DELETE", `/accounts/${this.accountId}/email/routing/addresses/${id}`);
    } catch (e) {
      if (!(e instanceof CloudflareError && e.status === 404)) throw e;
    }
  }
}
