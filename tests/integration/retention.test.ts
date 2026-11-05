import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml, type TestApp } from "../helpers.js";
import { runRetention } from "../../app/server/services/retention.js";
import { backfillAuthResults } from "../../app/server/services/maintenance.js";
import { messageRaw, messages, sessions } from "../../app/server/db/schema.js";
import { createSession } from "../../app/server/auth/tokens.js";

const DAY = 86400_000;

async function setup(env: Record<string, string> = {}) {
  const t = makeTestApp(env);
  const admin = await setupAdmin(t);
  await addDomain(admin, "mail.example.test");
  const user = loginAs(t, "u@example.org");
  t.deps.fetch = (async () => new Response("ok")) as typeof fetch;
  return { t, user };
}

const ids = (t: TestApp) =>
  t.deps.db
    .select({ id: messages.id })
    .from(messages)
    .all()
    .map((m) => m.id)
    .sort();

/** Moves a message's reception date `days` into the past. */
const age = (t: TestApp, id: string, days: number) =>
  t.deps.db
    .update(messages)
    .set({ receivedAt: t.deps.now() - days * DAY })
    .where(eq(messages.id, id))
    .run();

async function receive(t: TestApp, email: string, text: string, eml = simpleEml({ text })) {
  const before = new Set(ids(t));
  const r = await ingest(t, email, eml);
  expect(r.status).toBe(200);
  return ids(t).find((id) => !before.has(id))!;
}

describe("retention", () => {
  it("deletes messages older than RETENTION_DAYS and keeps recent ones", async () => {
    const { t, user } = await setup({ RETENTION_DAYS: "30" });
    const a = (await user.post("/v1/addresses", { site_name: "Shop" })).json.address;
    const old = await receive(t, a.email, "old");
    const recent = await receive(t, a.email, "recent");
    age(t, old, 31);
    age(t, recent, 29);
    expect(runRetention(t.deps)).toBe(1);
    expect(ids(t)).toEqual([recent]);
    // Idempotent.
    expect(runRetention(t.deps)).toBe(0);
  });

  it("keeps everything with RETENTION_DAYS=0, except where a category sets its own limit", async () => {
    const { t, user } = await setup({ RETENTION_DAYS: "0" });
    const cat = (await user.post("/v1/categories", { name: "Short", retention_days: 2 })).json.category;
    const shortLived = (await user.post("/v1/addresses", { site_name: "News" })).json.address;
    expect((await user.patch(`/v1/addresses/${shortLived.id}`, { category_id: cat.id })).status).toBe(200);
    const kept = (await user.post("/v1/addresses", { site_name: "Bank" })).json.address;
    const a = await receive(t, shortLived.email, "newsletter");
    const b = await receive(t, shortLived.email, "fresh newsletter");
    const c = await receive(t, kept.email, "statement");
    age(t, a, 3);
    age(t, b, 1);
    age(t, c, 3650);
    expect(runRetention(t.deps)).toBe(1);
    expect(ids(t)).toEqual([b, c].sort());
  });

  it("removes expired sessions and raw copies past their keep date", async () => {
    const { t, user } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "Shop" })).json.address;
    const m1 = await receive(t, a.email, "one");
    const m2 = await receive(t, a.email, "two");
    const m3 = await receive(t, a.email, "three");
    t.deps.db.delete(messageRaw).run();
    t.deps.db
      .insert(messageRaw)
      .values([
        { messageId: m1, raw: Buffer.from("x"), keepUntil: t.deps.now() - 1000 },
        { messageId: m2, raw: Buffer.from("y"), keepUntil: t.deps.now() + DAY },
        { messageId: m3, raw: Buffer.from("z"), keepUntil: null },
      ])
      .run();
    const owner = t.deps.db.select({ userId: messages.userId }).from(messages).get()!.userId;
    const live = createSession(t.deps, owner);
    const expired = createSession(t.deps, owner);
    t.deps.db
      .update(sessions)
      .set({ expiresAt: t.deps.now() - 1 })
      .where(eq(sessions.csrfToken, expired.csrfToken))
      .run();
    const before = t.deps.db.select().from(sessions).all().length;
    runRetention(t.deps);
    expect(t.deps.db.select().from(sessions).all()).toHaveLength(before - 1);
    expect(t.deps.db.select().from(sessions).where(eq(sessions.csrfToken, live.csrfToken)).get()).toBeTruthy();
    const raws = t.deps.db
      .select({ id: messageRaw.messageId })
      .from(messageRaw)
      .all()
      .map((r) => r.id)
      .sort();
    expect(raws).toEqual([m2, m3].sort());
    // The messages themselves are within the global retention and stay.
    expect(ids(t)).toHaveLength(3);
  });
});

describe("maintenance: SPF backfill", () => {
  it("recomputes stale SPF results once and leaves correct ones alone", async () => {
    const { t, user } = await setup();
    const a = (await user.post("/v1/addresses", { site_name: "Shop" })).json.address;
    const eml = simpleEml({ text: "hello" }).replace(
      "From:",
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass\r\nFrom:",
    );
    const m = await receive(t, a.email, "", eml);
    const spf = () => t.deps.db.select().from(messages).where(eq(messages.id, m)).get()!.spf;
    expect(spf()).toBe("pass");
    expect(backfillAuthResults(t.deps)).toBe(0);
    t.deps.db.update(messages).set({ spf: "fail" }).where(eq(messages.id, m)).run();
    // A row without stored headers is skipped.
    const other = await receive(t, a.email, "no headers");
    t.deps.db.update(messages).set({ headersJson: null, spf: "bogus" }).where(eq(messages.id, other)).run();
    expect(backfillAuthResults(t.deps)).toBe(1);
    expect(spf()).toBe("pass");
    expect(t.deps.db.select().from(messages).where(eq(messages.id, other)).get()!.spf).toBe("bogus");
    expect(backfillAuthResults(t.deps)).toBe(0);
  });
});
