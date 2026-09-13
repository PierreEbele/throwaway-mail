import type { CloudflareClient, DestinationInfo, DnsRecord, ZoneInfo } from "./index.js";
import { CloudflareError } from "./index.js";

/**
 * In-memory Cloudflare for local development and tests (CF_MOCK=1).
 * - Any domain is a valid zone, except names containing "invalid" (zone not found) or "nodns" (missing MX records).
 * - Destinations start unverified and become verified the first time their state is refreshed
 *   (simulates the owner clicking the verification link).
 */
export class MockCloudflareClient implements CloudflareClient {
  readonly mode = "mock" as const;
  zones = new Map<string, { routing: boolean; catchAllWorker?: string }>();
  destinations = new Map<string, DestinationInfo & { checks: number }>();
  private seq = 0;

  async findZone(domain: string): Promise<ZoneInfo | null> {
    if (domain.includes("invalid")) return null;
    return { id: `mockzone_${domain.replace(/\W/g, "_")}`, name: domain, status: "active" };
  }
  async enableEmailRouting(zoneId: string): Promise<void> {
    const z = this.zones.get(zoneId) ?? { routing: false };
    z.routing = true;
    this.zones.set(zoneId, z);
  }
  async setCatchAllToWorker(zoneId: string, workerName: string): Promise<void> {
    const z = this.zones.get(zoneId);
    if (!z?.routing) throw new CloudflareError("Email Routing is not enabled on this zone", 400, 2007);
    z.catchAllWorker = workerName;
  }
  async missingDnsRecords(_zoneId: string, domain: string): Promise<DnsRecord[]> {
    if (!domain.includes("nodns")) return [];
    return [
      { type: "MX", name: domain, content: "route1.mx.cloudflare.net", priority: 13 },
      { type: "MX", name: domain, content: "route2.mx.cloudflare.net", priority: 86 },
      { type: "TXT", name: domain, content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
    ];
  }
  async createDestination(email: string): Promise<DestinationInfo> {
    const existing = await this.findDestinationByEmail(email);
    if (existing) return existing;
    const d = { id: `mockdest_${++this.seq}`, email, verified: null, checks: 0 };
    this.destinations.set(d.id, d);
    return { id: d.id, email, verified: null };
  }
  async getDestination(id: string): Promise<DestinationInfo | null> {
    const d = this.destinations.get(id);
    if (!d) return null;
    d.checks++;
    if (!d.verified) d.verified = new Date().toISOString();
    return { id: d.id, email: d.email, verified: d.verified };
  }
  async findDestinationByEmail(email: string): Promise<DestinationInfo | null> {
    for (const d of this.destinations.values()) if (d.email === email) return { id: d.id, email: d.email, verified: d.verified };
    return null;
  }
  async deleteDestination(id: string): Promise<void> {
    this.destinations.delete(id);
  }
}
