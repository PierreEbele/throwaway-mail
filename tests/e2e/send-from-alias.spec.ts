import { expect, test } from "@playwright/test";
import { SMTPServer } from "smtp-server";
import { domainAndAddress, ssoLogin } from "./support.js";

/** The relay the e2e server sends through (SMTP_RELAY_URL in playwright.config.ts). */
const RELAY_PORT = 3297;
const received: Array<{ from: string; to: string[]; raw: string }> = [];
let relay: SMTPServer;

test.beforeAll(async () => {
  relay = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString(),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => relay.listen(RELAY_PORT, "127.0.0.1", () => resolve()));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});

test("compose and send a new mail from an alias", async ({ page }) => {
  await ssoLogin(page);
  const a = await domainAndAddress(page, "send.e2e.test", "e2e-sender", "Sending shop");
  await page.goto(`/addresses/${a.id}`);
  await expect(page.getByRole("heading", { name: "Sending shop" })).toBeVisible();

  await page.getByRole("button", { name: "New mail" }).click();
  await page.getByLabel("From name", { exact: true }).fill("Shopper");
  await page.getByLabel("To", { exact: true }).fill("bob@shop.example");
  await page.getByLabel("Subject", { exact: true }).fill("Where is my order?");
  await page.getByLabel("Message", { exact: true }).fill("Hello Bob, any news about order 1234?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Sent to bob@shop.example")).toBeVisible();

  await expect.poll(() => received.length).toBe(1);
  const m = received[0]!;
  expect(m.to).toEqual(["bob@shop.example"]);
  expect(m.from).toBe(a.email);
  expect(m.raw).toContain(`From: "Shopper" <${a.email}>`);
  expect(m.raw).toContain("Subject: Where is my order?");
  expect(m.raw).toContain("any news about order 1234?");
  // The recipient became a contact of the alias.
  await page.reload();
  await expect(page.getByText("bob@shop.example").first()).toBeVisible();
});
