import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ingestSignature } from "../../app/server/routes/ingest.js";

test("SSO sign-in, domain, address lifecycle and live code", async ({ page, request }) => {
  // Single sign-on through the (fake) identity provider; "dory" is in the admins group
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("link", { name: "Sign in with Authelia" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Domains" })).toBeVisible(); // admin menu

  // Add a domain (mock Cloudflare) and see it become active
  await page.getByRole("link", { name: "Domains" }).click();
  await page.getByLabel("Domain name").fill("mail.e2e.test");
  await page.getByRole("button", { name: "Add domain" }).click();
  const domainCard = page.getByTestId("domain-mail.e2e.test");
  await expect(domainCard.getByText("active", { exact: true })).toBeVisible();

  // Create an address linked to a site
  await page.getByRole("link", { name: "Inbox" }).click();
  await page.getByRole("button", { name: "+ New" }).click();
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

  // The list (middle pane) shows the site linked to the address
  const row = page.getByRole("link", { name: /GitHub \(work\), e2e-github@mail\.e2e\.test/ });
  await expect(row).toBeVisible();

  // Category + pin
  await page.getByRole("button", { name: "New category" }).click();
  await page.getByLabel("Name").fill("Dev");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Category", { exact: true }).selectOption({ label: "Dev" });
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pinned", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Dev/ }).click();
  await expect(page.getByRole("heading", { name: "Dev" })).toBeVisible();
  await expect(row).toBeVisible();
  await page.getByRole("link", { name: "Pinned" }).click();
  await expect(row).toBeVisible();

  // Delete
  await row.click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(row).toBeHidden();
});
