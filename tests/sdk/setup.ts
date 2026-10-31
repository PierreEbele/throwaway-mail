import { ThrowawayMail } from "../../sdk/src/index.js";
import { addDomain, makeTestApp, setupAdmin, type TestApp } from "../helpers.js";

export const DOMAIN = "mail.example.test";

/** Real app + an SDK client whose fetch is routed to app.request (no network). */
export async function sdkFixture() {
  const t: TestApp = makeTestApp();
  const admin = await setupAdmin(t);
  await addDomain(admin, DOMAIN);
  const k = await admin.post("/v1/keys", { name: "sdk-test" });
  if (k.status !== 201) throw new Error(`key failed: ${JSON.stringify(k.json)}`);
  const calls: string[] = [];
  const tm = new ThrowawayMail({
    baseUrl: "http://localhost:3000/",
    apiKey: k.json.key,
    fetch: async (url, init) => {
      const u = new URL(url);
      calls.push(`${init.method} ${u.pathname}${u.search}`);
      return t.app.request(u.pathname + u.search, init);
    },
  });
  return { t, admin, tm, calls };
}
