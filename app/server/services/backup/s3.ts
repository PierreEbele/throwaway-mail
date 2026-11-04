import { AwsClient } from "aws4fetch";

export interface S3Settings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Minimal S3 client (path-style URLs, SigV4 via aws4fetch): enough for R2, Backblaze B2, MinIO and AWS. */
export class S3Store {
  private aws: AwsClient;
  constructor(
    private s: S3Settings,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.aws = new AwsClient({ accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, service: "s3", region: s.region });
  }

  private url(key = "", query = "") {
    const base = `${this.s.endpoint.replace(/\/$/, "")}/${encodeURIComponent(this.s.bucket)}`;
    const path = key ? "/" + key.split("/").map(encodeURIComponent).join("/") : "/";
    return base + path + (query ? `?${query}` : "");
  }

  private async call(method: string, url: string, body?: Uint8Array) {
    const init: RequestInit = { method, body: body as BodyInit | undefined };
    const req = await this.aws.sign(url, init);
    const res = await this.fetchImpl(req.url, {
      method,
      headers: req.headers,
      body: body as BodyInit | undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`S3 ${method} ${new URL(url).pathname} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async put(key: string, body: Uint8Array) {
    await this.call("PUT", this.url(key), body);
  }

  async get(key: string): Promise<Buffer> {
    return Buffer.from(await (await this.call("GET", this.url(key))).arrayBuffer());
  }

  async delete(key: string) {
    await this.call("DELETE", this.url(key));
  }

  /** Every key under `prefix` (follows continuation tokens). */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix });
      if (token) q.set("continuation-token", token);
      const xml = await (await this.call("GET", this.url("", q.toString()))).text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unxml(m[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? "") || null : null;
    } while (token);
    return keys;
  }
}

const unxml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
