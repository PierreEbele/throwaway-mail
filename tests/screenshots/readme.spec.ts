import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ingestSignature } from "../../app/server/routes/ingest.js";
import { DEMO_SITES } from "../../app/server/services/demo.js";

const DOMAIN = "mail.example.test";
const OUT = "docs/images";

// Same sites, categories and mails as the public demo seed (DEMO_MODE).
const SITES = DEMO_SITES;

async function deliver(request: APIRequestContext, to: string, from: string, fixture: string) {
  const raw = fs.readFileSync(path.resolve("tests/fixtures", fixture));
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await request.post("/ingest", {
    headers: {
      "x-tm-timestamp": ts,
      "x-tm-signature": ingestSignature("e2e-ingest-secret-0123456789", ts, from, to, raw),
      "x-tm-envelope-from": from,
      "x-tm-envelope-to": to,
      "content-type": "message/rfc822",
    },
    data: raw,
  });
  expect(res.ok()).toBeTruthy();
}

/** Waits for toasts to disappear, then saves docs/images/<name>.png. */
async function shot(page: Page, name: string) {
  await expect(page.locator('[role="status"][aria-live] > *')).toHaveCount(0, { timeout: 10_000 });
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function open(page: Page, url: string, heading: string | RegExp) {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
}

test("documentation screenshots", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Authelia" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  await page.getByRole("link", { name: "Domains" }).click();
  await page.getByLabel("Domain name").fill(DOMAIN);
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByTestId(`domain-${DOMAIN}`).getByText("active", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Inbox" }).click();
  for (const category of new Set(SITES.map((s) => s.category))) {
    await page.getByRole("button", { name: "New category" }).click();
    await page.getByLabel("Name").fill(category);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("link", { name: new RegExp(`^${category}`) })).toBeVisible();
  }

  for (const s of SITES) {
    await page.getByRole("link", { name: "Inbox" }).click();
    await page.getByRole("button", { name: "+ New" }).click();
    await page.getByLabel("Site name").fill(s.name);
    await page.getByLabel(/Site URL/).fill(s.url);
    await page.getByLabel(/Local part/).fill(s.local);
    if (s.name === "GitHub") await shot(page, "new-address");
    await page.getByRole("button", { name: "Create address" }).click();
    await expect(page.getByRole("heading", { name: s.name })).toBeVisible();
    await page.getByLabel("Category", { exact: true }).selectOption({ label: s.category });
    await deliver(request, `${s.local}@${DOMAIN}`, s.from, s.mail);
  }
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(page.getByTestId("latest-code")).toHaveText("593201");
  await page.getByRole("link", { name: "Inbox" }).click();
  await page.getByRole("link", { name: /GitHub, silver-otter-4821/ }).click();
  await expect(page.getByTestId("latest-code")).toHaveText("593201");
  await shot(page, "inbox");

  await page.getByRole("link", { name: /^Shopping/ }).click();
  await expect(page.getByRole("heading", { name: "Shopping" })).toBeVisible();
  await shot(page, "category");

  await open(page, "/digest", /This week/);
  await shot(page, "digest");
  await open(page, "/destinations", /Destinations/);
  await shot(page, "destinations");
  await open(page, "/keys", /API keys/);
  await shot(page, "api-keys");
  await open(page, "/admin/domains", /Domains/);
  await shot(page, "domains");
  await open(page, "/admin/users", /Users/);
  await shot(page, "users");
  await open(page, "/admin/audit", "Audit log");
  await shot(page, "audit-log");
  await open(page, "/admin/health", /Health/);
  await shot(page, "health");
  await open(page, "/admin/setup-check", "Setup check");
  await page.getByText(/checked/).waitFor();
  await shot(page, "setup-check");
});
