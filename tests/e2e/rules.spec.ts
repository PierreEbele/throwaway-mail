import { expect, test } from "@playwright/test";
import { domainAndAddress, ingestMail, ssoLogin } from "./support.js";

const mail = (from: string, to: string, subject: string) =>
  [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@e2e.test>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Hello from the e2e test.",
    "",
  ].join("\r\n");

test("create a rule in the builder and see it quarantine matching mail", async ({ page, request }) => {
  await ssoLogin(page);
  const a = await domainAndAddress(page, "rules.e2e.test", "e2e-rules", "Rules shop");

  await page.getByRole("link", { name: "Rules", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByRole("form", { name: "New rule" });
  await form.getByLabel("Name", { exact: true }).fill("Quarantine spammy.example");
  await form.getByLabel("Condition", { exact: true }).selectOption({ label: "Sender's domain" });
  await form.getByLabel("Value", { exact: true }).fill("spammy.example");
  await form.getByLabel("Action", { exact: true }).selectOption({ label: "Quarantine it (keep, do not forward)" });
  await form.getByRole("button", { name: "Create rule" }).click();

  const list = page.getByRole("list", { name: "Rules, in the order they run" });
  await expect(list.getByText("1. Quarantine spammy.example")).toBeVisible();

  // Matching mail is held in quarantine (stored, never forwarded); other mail is not.
  const quarantined = async () =>
    ((await (await page.request.get("/v1/quarantine")).json()).messages as Array<{ subject: string }>).map((m) => m.subject);
  for (const [from, subject] of [
    ["promo@spammy.example", "Buy now"],
    ["friend@other.example", "Hi friend"],
  ])
    expect((await ingestMail(request, from!, a.email, mail(`Sender <${from}>`, a.email, subject!))).action).toBe("store_only");
  expect(await quarantined()).toEqual(["Buy now"]);

  await page.getByRole("link", { name: "Quarantine", exact: true }).click();
  await expect(page.getByText("Buy now").first()).toBeVisible();
  await expect(page.getByText("Hi friend")).toBeHidden();

  // Turning the rule off lets the same sender through.
  await page.getByRole("link", { name: "Rules", exact: true }).click();
  await page.getByLabel("Enable Quarantine spammy.example").click();
  await expect(list.locator("li").first()).toHaveClass(/opacity-60/);
  await ingestMail(request, "promo@spammy.example", a.email, mail("Promo <promo@spammy.example>", a.email, "Again"));
  expect(await quarantined()).toEqual(["Buy now"]);
});
