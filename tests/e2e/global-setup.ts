import { request, type FullConfig } from "@playwright/test";

/**
 * Local accounts are enabled next to SSO (LOCAL_LOGIN=true), so an instance without users would send everyone to the
 * first-run setup page. Create that first account up front, so the specs start from a set-up instance.
 */
export default async function globalSetup(config: FullConfig) {
  const ctx = await request.newContext({ baseURL: config.projects[0]!.use.baseURL });
  const r = await ctx.post("/v1/auth/setup", {
    data: { email: "e2e-owner@example.org", name: "Owner", password: "e2e owner password 0042" },
  });
  if (!r.ok() && r.status() !== 403) throw new Error(`setup failed: ${r.status()} ${await r.text()}`);
  await ctx.dispose();
}
