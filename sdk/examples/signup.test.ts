/**
 * End-to-end sign-up test with a fresh disposable address.
 *
 *   TM_URL=https://mail-app.example.com TM_API_KEY=tm_… node --test --experimental-strip-types examples/signup.test.ts
 *
 * Replace `signUp()` with what your own test does (Playwright, an HTTP call to your API…).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ThrowawayMail } from "@throwaway-mail/sdk";

const tm = new ThrowawayMail({ baseUrl: process.env.TM_URL!, apiKey: process.env.TM_API_KEY! });
const created: string[] = [];

// Stand-in for the app under test: it is supposed to e-mail a verification code to `email`.
async function signUp(email: string) {
  console.log(`sign up with ${email} and send it a verification code`);
}

test("a new user receives a verification code", async () => {
  // 1. A fresh address, filed under "E2E tests", that stops accepting mail after one day.
  const address = await tm.addresses.create({
    siteName: "My app (e2e)",
    category: "E2E tests",
    createCategory: true,
    expiresInDays: 1,
  });
  created.push(address.id);

  // 2. Sign up, then wait for the mail: the code is already extracted.
  const since = Date.now();
  await signUp(address.email);
  const { code } = await tm.addresses.waitForCode(address.id, { since, timeoutMs: 60_000 });

  assert.match(code!, /^\d{6}$/);
});

after(async () => {
  for (const id of created) await tm.addresses.delete(id);
});
