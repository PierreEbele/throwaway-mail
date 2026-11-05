import { expect, request as playwrightRequest, test } from "@playwright/test";
import { totp } from "../../app/server/lib/totp.js";
import { api, ssoLogin } from "./support.js";

const EMAIL = "e2e-2fa@example.org";
const PASSWORD = "a long e2e password 4821";

test("local account with two-factor authentication signs in with a password and an app code", async ({ page, browser, baseURL }) => {
  // An admin (single sign-on) invites a local account.
  await ssoLogin(page);
  const invite = await (await api(page.request)).post("/v1/admin/invites", { email: EMAIL, role: "user" });
  const token = new URL(invite.url as string).pathname.split("/").pop()!;

  // The invitee accepts and turns on two-factor authentication (an authenticator app holds the secret).
  const invitee = await playwrightRequest.newContext({ baseURL });
  const accepted = await invitee.post(`/v1/auth/invite/${token}`, { data: { name: "Two Factor", password: PASSWORD } });
  expect(accepted.ok()).toBe(true);
  const me = await api(invitee);
  const { secret } = await me.post("/v1/auth/2fa/setup", { password: PASSWORD });
  const enabled = await me.post("/v1/auth/2fa/enable", { code: totp(secret, Date.now()) });
  expect(enabled.recovery_codes).toHaveLength(10);
  await invitee.dispose();

  // Signing in from a fresh browser now asks for a code after the password.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByLabel("E-mail").fill(EMAIL);
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(p.getByText("Enter the 6-digit code from your authenticator app.")).toBeVisible();

  // A wrong code is refused and keeps the user on the code step.
  await p.getByLabel("Code").fill("000000");
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(p.getByRole("alert")).toBeVisible();

  // The next step's code (the current one was used to enable 2FA and cannot be replayed).
  await p.getByLabel("Code").fill(totp(secret, Date.now() + 30_000));
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(p.getByRole("heading", { name: "Inbox" })).toBeVisible();
  // A regular user: no admin menu.
  await expect(p.getByRole("link", { name: "Domains" })).toBeHidden();
  await ctx.close();
});
