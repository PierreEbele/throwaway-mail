import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { ingestSignature } from "../../app/server/routes/ingest.js";

export const INGEST_SECRET = "e2e-ingest-secret-0123456789";

/** Signs in through the fake identity provider ("admin" is in the admins group). */
export async function ssoLogin(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("link", { name: "Sign in with Authelia" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
}

/** JSON API calls with a request context (the page's, or a standalone one) and its session's CSRF token. */
export async function api(req: APIRequestContext) {
  const me = await req.get("/v1/auth/me");
  expect(me.ok()).toBe(true);
  const csrf = (await me.json()).csrf_token as string;
  const call = async (method: "post" | "patch", url: string, data: unknown) => {
    const r = await req[method](url, { data, headers: { "x-csrf-token": csrf } });
    const json = await r.json();
    if (!r.ok()) throw new Error(`${method.toUpperCase()} ${url} → ${r.status()}: ${JSON.stringify(json)}`);
    return json;
  };
  return {
    post: (url: string, data: unknown = {}) => call("post", url, data),
    patch: (url: string, data: unknown) => call("patch", url, data),
  };
}

/** Creates a domain (mock Cloudflare) and an address on it; returns the address. */
export async function domainAndAddress(page: Page, domain: string, localPart: string, siteName: string) {
  const a = await api(page.request);
  await a.post("/v1/domains", { name: domain, unknown_policy: "reject" });
  return (await a.post("/v1/addresses", { site_name: siteName, local_part: localPart, domain })).address as { id: string; email: string };
}

/** Delivers a raw mail the way the Cloudflare Worker does. */
export async function ingestMail(request: APIRequestContext, from: string, to: string, raw: string | Buffer) {
  const body = typeof raw === "string" ? Buffer.from(raw) : raw;
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await request.post("/ingest", {
    headers: {
      "x-tm-timestamp": ts,
      "x-tm-signature": ingestSignature(INGEST_SECRET, ts, from, to, body),
      "x-tm-envelope-from": from,
      "x-tm-envelope-to": to,
      "content-type": "message/rfc822",
    },
    data: body,
  });
  return res.json();
}
