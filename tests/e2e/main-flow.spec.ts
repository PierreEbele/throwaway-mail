import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ingestSignature } from "../../app/server/routes/ingest.js";

const PASSWORD = "e2e-admin-password-1";

test("admin setup, domain, address lifecycle and live code", async ({ page, request }) => {
  // First-run setup
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Setup token").fill("e2e-setup-token-0123456789");
  await page.getByLabel("Admin email").fill("admin@e2e.test");
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.getByRole("heading", { name: "Addresses" })).toBeVisible();

  // Add a domain (mock Cloudflare) and see it become active
  await page.getByRole("link", { name: "Domains" }).click();
  await page.getByLabel("Domain name").fill("mail.e2e.test");
  await page.getByRole("button", { name: "Add domain" }).click();
  const domainCard = page.getByTestId("domain-mail.e2e.test");
  await expect(domainCard.getByText("active", { exact: true })).toBeVisible();

  // Create an address linked to a site
  await page.getByRole("link", { name: "Addresses" }).click();
  await page.getByRole("button", { name: "+ New address" }).click();
  await page.getByLabel("Site name").fill("GitHub");
  await page.getByLabel(/Site URL/).fill("github.com");
  await page.getByLabel(/Local part/).fill("e2e-github");
  await page.getByRole("button", { name: "Create address" }).click();
  await expect(page.getByRole("heading", { name: "GitHub" })).toBeVisible();
  await expect(page.getByRole("code").filter({ hasText: "e2e-github@mail.e2e.test" })).toBeVisible();
  await expect(page.getByRole("link", { name: "github.com ↗" })).toHaveAttribute("href", "https://github.com");

  // A mail arrives: the code card updates live (SSE)
  const raw = fs.readFileSync(path.resolve("tests/fixtures/github-device-verification.eml"));
  const ts = String(Math.floor(Date.now() / 1000));
  const to = "e2e-github@mail.e2e.test";
  const res = await request.post("/ingest", {
    headers: {
      "x-tm-timestamp": ts,
      "x-tm-signature": ingestSignature("e2e-ingest-secret-0123456789", ts, "noreply@github.com", to, raw),
      "x-tm-envelope-from": "noreply@github.com",
      "x-tm-envelope-to": to,
      "content-type": "message/rfc822",
    },
    data: raw,
  });
  expect((await res.json()).action).toBe("store_only");
  await expect(page.getByTestId("latest-code")).toHaveText("593201");

  // Rename
  await page.getByRole("button", { name: "Edit site" }).click();
  await page.getByLabel("Site name").fill("GitHub (work)");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: /GitHub \(work\)/ })).toBeVisible();

  // Pause / resume
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("new mail is rejected")).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("new mail is rejected")).toBeHidden();

  // The list shows the site linked to the address
  await page.getByRole("link", { name: "← All addresses" }).click();
  const row = page.getByRole("link", { name: /GitHub \(work\), e2e-github@mail\.e2e\.test/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("github.com")).toBeVisible();

  // Delete
  await row.click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No addresses yet")).toBeVisible();
});
