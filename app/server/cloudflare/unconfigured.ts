import type { CloudflareClient } from "./index.js";
import { CloudflareError } from "./index.js";

/** Used when CF_API_TOKEN / CF_ACCOUNT_ID are not set: the app runs, Cloudflare actions fail with a clear message. */
export class UnconfiguredCloudflareClient implements CloudflareClient {
  readonly mode = "unconfigured" as const;
  private fail(): never {
    throw new CloudflareError("Cloudflare is not configured: set CF_API_TOKEN and CF_ACCOUNT_ID in the app's .env and restart it", 503);
  }
  findZone = async () => this.fail();
  enableEmailRouting = async () => this.fail();
  setCatchAllToWorker = async () => this.fail();
  getCatchAll = async () => this.fail();
  setCatchAll = async () => this.fail();
  missingDnsRecords = async () => this.fail();
  createDestination = async () => this.fail();
  getDestination = async () => this.fail();
  findDestinationByEmail = async () => this.fail();
  deleteDestination = async () => this.fail();
}
