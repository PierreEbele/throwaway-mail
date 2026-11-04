import { expect, test, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ingestSignature } from "../../app/server/routes/ingest.js";

const DOMAIN = "mail.example.test";
const OUT = "docs/images";

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

test("README screenshots", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with Authelia" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  await page.getByRole("link", { name: "Domains" }).click();
  await page.getByLabel("Domain name").fill(DOMAIN);
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByTestId(`domain-${DOMAIN}`).getByText("active", { exact: true })).toBeVisible();

  const sites = [
    { name: "Discord", url: "discord.com", local: "quiet-heron-2210", mail: "discord-verify-email.eml", from: "noreply@discord.com" },
    { name: "Amazon", url: "amazon.com", local: "amber-lynx-5307", mail: "amazon-otp.eml", from: "account-update@amazon.com" },
    { name: "GitHub", url: "github.com", local: "silver-otter-4821", mail: "github-device-verification.eml", from: "noreply@github.com" },
  ];
  for (const s of sites) {
    await page.getByRole("link", { name: "Inbox" }).click();
    await page.getByRole("button", { name: "+ New" }).click();
    await page.getByLabel("Site name").fill(s.name);
    await page.getByLabel(/Site URL/).fill(s.url);
    await page.getByLabel(/Local part/).fill(s.local);
    await page.getByRole("button", { name: "Create address" }).click();
    await expect(page.getByRole("heading", { name: s.name })).toBeVisible();
    await deliver(request, `${s.local}@${DOMAIN}`, s.from, s.mail);
  }
  await expect(page.getByTestId("latest-code")).toHaveText("593201");
  await expect(page.locator('[role="status"][aria-live] > *')).toHaveCount(0, { timeout: 10_000 }); // toasts gone
  await page.screenshot({ path: `${OUT}/address.png` });

  await page.goto("/admin/setup-check");
  await expect(page.getByRole("heading", { name: "Setup check" })).toBeVisible();
  await page.getByText(/checked/).waitFor();
  await page.screenshot({ path: `${OUT}/setup-check.png` });
});
