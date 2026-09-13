import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../app/server/config.js";
import { buildDeps } from "../app/server/build-deps.js";
import { createApp } from "../app/server/app.js";
import { openDatabase } from "../app/server/db/index.js";
import { silentLogger } from "../app/server/logger.js";
import { MockCloudflareClient } from "../app/server/cloudflare/index.js";
import { ingestSignature, INGEST_HEADERS } from "../app/server/routes/ingest.js";
import type { Deps } from "../app/server/context.js";

export const FIXTURES = path.join(__dirname, "fixtures");
export const SECRET = "test-ingest-secret-0123456789";

export function makeTestApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    CF_MOCK: "1",
    INGEST_SECRET: SECRET,
    APP_URL: "http://localhost:3000",
    LOGIN_RATE_LIMIT_PER_MINUTE: "1000",
    RATE_LIMIT_PER_MINUTE: "100000",
    WEB_DIST_DIR: "/nonexistent",
    ...env,
  });
  const db = openDatabase(":memory:", path.join(__dirname, "..", "app/server/db/migrations"));
  const cf = new MockCloudflareClient();
  const deps = buildDeps(config, silentLogger, { db, cf });
  const app = createApp(deps);
  return { app, deps, cf };
}

export type TestApp = ReturnType<typeof makeTestApp>;

/** Minimal HTTP client around app.request that keeps a session cookie and CSRF token. */
export class Client {
  cookie = "";
  csrf = "";
  bearer = "";
  constructor(private t: TestApp) {}

  async req(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    else if (this.cookie) {
      headers.cookie = this.cookie;
      if (method !== "GET" && this.csrf) headers["x-csrf-token"] = this.csrf;
    }
    const res = await this.t.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie?.startsWith("tm_session=")) this.cookie = setCookie.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (json?.csrf_token) this.csrf = json.csrf_token;
    return { status: res.status, json, headers: res.headers };
  }
  get = (u: string) => this.req("GET", u);
  post = (u: string, b: unknown = {}) => this.req("POST", u, b);
  patch = (u: string, b: unknown) => this.req("PATCH", u, b);
  del = (u: string) => this.req("DELETE", u);
}

export async function setupAdmin(t: TestApp, email = "admin@example.org") {
  const c = new Client(t);
  const r = await c.post("/v1/auth/setup", { token: t.deps.setup.token, email, password: "correct horse battery" });
  if (r.status !== 201) throw new Error(`setup failed: ${JSON.stringify(r.json)}`);
  return c;
}

export async function inviteUser(t: TestApp, admin: Client, email: string) {
  const inv = await admin.post("/v1/admin/invites", { email });
  const token = inv.json.token as string;
  const c = new Client(t);
  const r = await c.post("/v1/auth/accept-invite", { token, password: "another long password" });
  if (r.status !== 201) throw new Error(`invite failed: ${JSON.stringify(r.json)}`);
  return c;
}

export async function addDomain(admin: Client, name = "mail.example.test", unknown_policy = "reject") {
  const r = await admin.post("/v1/domains", { name, unknown_policy });
  if (r.status !== 201) throw new Error(`domain failed: ${JSON.stringify(r.json)}`);
  return r.json.domain;
}

export function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, name));
}

export async function ingest(
  t: TestApp,
  to: string,
  raw: Buffer | string,
  opts: { from?: string; secret?: string; timestamp?: number; signature?: string } = {},
) {
  const body = typeof raw === "string" ? Buffer.from(raw) : raw;
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const from = opts.from ?? "sender@example.com";
  const sig = opts.signature ?? ingestSignature(opts.secret ?? SECRET, ts, from, to, body);
  const res = await t.app.request("/ingest", {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "content-length": String(body.byteLength),
      [INGEST_HEADERS.timestamp]: ts,
      [INGEST_HEADERS.signature]: sig,
      [INGEST_HEADERS.from]: from,
      [INGEST_HEADERS.to]: to,
    },
    body: new Uint8Array(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

export function simpleEml(opts: { subject?: string; text: string; messageId?: string; from?: string }) {
  return [
    `From: ${opts.from ?? "Example <noreply@example.com>"}`,
    `To: someone@mail.example.test`,
    `Subject: ${opts.subject ?? "Hello"}`,
    `Message-ID: ${opts.messageId ?? `<${Math.random().toString(36).slice(2)}@example.com>`}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    opts.text,
    "",
  ].join("\r\n");
}

export type { Deps };
