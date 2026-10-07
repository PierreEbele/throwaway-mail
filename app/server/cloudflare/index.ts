/** Everything the app needs from Cloudflare, behind an interface so it can be mocked. */
export interface DnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
}

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
}

export interface DestinationInfo {
  id: string;
  email: string;
  verified: string | null; // ISO timestamp once the owner clicked the link
}

export interface CatchAllRule {
  enabled: boolean;
  actions: Array<{ type: string; value?: string[] }>;
}

export interface CloudflareClient {
  readonly mode: "live" | "mock" | "unconfigured";
  findZone(domain: string): Promise<ZoneInfo | null>;
  enableEmailRouting(zoneId: string, domain: string): Promise<void>;
  setCatchAllToWorker(zoneId: string, workerName: string): Promise<void>;
  /** Current catch-all rule of the zone (null when Email Routing has none). */
  getCatchAll(zoneId: string): Promise<CatchAllRule | null>;
  /** Put a catch-all rule back (used to restore the previous one). */
  setCatchAll(zoneId: string, rule: CatchAllRule): Promise<void>;
  /** DNS records Email Routing needs that are not present (empty = all good). */
  missingDnsRecords(zoneId: string, domain: string, zoneName: string): Promise<DnsRecord[]>;
  createDestination(email: string): Promise<DestinationInfo>;
  getDestination(id: string): Promise<DestinationInfo | null>;
  findDestinationByEmail(email: string): Promise<DestinationInfo | null>;
  deleteDestination(id: string): Promise<void>;
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    public status: number,
    public cfCode?: number,
  ) {
    super(message);
  }
}

export { LiveCloudflareClient } from "./live.js";
export { MockCloudflareClient } from "./mock.js";
export { UnconfiguredCloudflareClient } from "./unconfigured.js";
