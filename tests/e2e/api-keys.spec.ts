import { expect, test } from "@playwright/test";
import { api, ssoLogin } from "./support.js";

test("create an API key restricted to some domains, then use it", async ({ page, playwright, baseURL }) => {
  await ssoLogin(page);
  const a = await api(page.request);
  for (const name of ["keep.keys.e2e.test", "other.keys.e2e.test"]) await a.post("/v1/domains", { name, unknown_policy: "reject" });

  await page.goto("/keys");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await page.getByLabel("Key name").fill("one-domain-bot");
  await page.getByLabel(/^Only some domains/).check();
  // Address and domain restrictions exclude each other, and a domain must be picked before creating.
  await expect(page.getByLabel(/^Only some addresses/)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Create key" })).toBeDisabled();
  await page.getByLabel("keep.keys.e2e.test").check();
  await page.getByRole("button", { name: "Create key" }).click();

  const secret = (await page.getByTestId("new-key").textContent())!.trim();
  expect(secret).toMatch(/^tm_/);
  await page.getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("row", { name: /one-domain-bot/ });
  await expect(row.getByText("1 domain")).toBeVisible();

  // The key only creates addresses on its domain, whatever is asked.
  const key = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  const made = await key.post("/v1/addresses", { data: { site_name: "Shop", domain_choice: "random" } });
  expect(made.status()).toBe(201);
  expect((await made.json()).email).toMatch(/@keep\.keys\.e2e\.test$/);
  expect((await key.post("/v1/addresses", { data: { site_name: "Shop", domain: "other.keys.e2e.test" } })).status()).toBe(403);

  // Leave the shared server as it was: other specs create addresses on an automatic domain.
  expect((await key.delete(`/v1/addresses/${(await made.json()).id}`)).ok()).toBe(true);
  await key.dispose();
  const csrf = (await (await page.request.get("/v1/auth/me")).json()).csrf_token as string;
  const doms = (await (await page.request.get("/v1/domains")).json()).domains as { id: string; name: string }[];
  for (const d of doms.filter((x) => x.name.endsWith(".keys.e2e.test")))
    expect((await page.request.delete(`/v1/domains/${d.id}`, { headers: { "x-csrf-token": csrf } })).ok()).toBe(true);
});
