import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addDomain, ingest, loginAs, makeTestApp, setupAdmin, simpleEml } from "../helpers.js";
import { fakeMail } from "../mail-fakes.js";
import { domains } from "../../app/server/db/schema.js";
import { pollMailbox } from "../../app/server/services/mailbox/poller.js";

describe("catch-all auto-create", () => {
  it("creates unknown addresses for the configured user and category (Cloudflare transport)", async () => {
    const t = makeTestApp();
    const admin = await setupAdmin(t);
    const dom = await addDomain(admin, "mail.example.test");
    const user = loginAs(t, "u@example.org");
    const uid = (await user.get("/v1/auth/me")).json.user.id;

    // Off by default: unknown recipients are rejected.
    expect((await ingest(t, "shop@mail.example.test", simpleEml({ text: "hi" }))).json).toMatchObject({ action: "reject" });

    const r = await admin.patch(`/v1/domains/${dom.id}`, {
      unknown_policy: "auto_create",
      auto_create_user_id: uid,
      auto_create_category: "Catch-all",
    });
    expect(r.status).toBe(200);
    expect(r.json.domain).toMatchObject({ auto_create_user_id: uid, auto_create_category: "Catch-all" });

    expect((await ingest(t, "shop@mail.example.test", simpleEml({ text: "hi" }), { from: "news@shop.com" })).json.action).toBe(
      "store_only",
    );
    const list = (await user.get("/v1/addresses")).json.addresses;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: "shop@mail.example.test", site_name: "shop.com", label: "auto-created" });
    const cats = (await user.get("/v1/categories")).json.categories;
    expect(list[0].category_id).toBe(cats.find((c: { name: string }) => c.name === "Catch-all").id);
    // The admin (domain owner) got nothing.
    expect((await admin.get("/v1/addresses")).json.addresses).toHaveLength(0);

    // Unknown user id is refused; clearing falls back to the domain owner.
    expect((await admin.patch(`/v1/domains/${dom.id}`, { auto_create_user_id: "usr_nope" })).status).toBe(400);
    expect((await admin.patch(`/v1/domains/${dom.id}`, { auto_create_user_id: null })).json.domain).toMatchObject({
      auto_create_user_id: null,
      auto_create_category_id: null,
    });
    await ingest(t, "other@mail.example.test", simpleEml({ text: "hi" }));
    expect((await admin.get("/v1/addresses")).json.addresses[0].email).toBe("other@mail.example.test");
  });

  it("works for IMAP domains", async () => {
    const fake = fakeMail();
    const t = makeTestApp({ APP_SECRET: "s".repeat(40) }, { mail: fake.clients });
    const admin = await setupAdmin(t);
    const r = await admin.post("/v1/domains", {
      name: "imap.example.test",
      transport: "imap",
      unknown_policy: "auto_create",
      auto_create_category: "Auto",
      mailbox: { imap_host: "imap.p.example", imap_user: "c@p.example", imap_password: "imap-pass" },
    });
    expect(r.status).toBe(201);
    fake.imap.deliver(simpleEml({ text: "hello" }).replace("To: someone@mail.example.test", "To: fresh@imap.example.test"));
    const dom = t.deps.db.select().from(domains).where(eq(domains.name, "imap.example.test")).get()!;
    expect((await pollMailbox(t.deps, dom)).processed).toBe(1);
    const a = (await admin.get("/v1/addresses")).json.addresses[0];
    expect(a).toMatchObject({ email: "fresh@imap.example.test", message_count: 1 });
    expect(a.category_id).toBe(dom.autoCreateCategoryId);
  });
});
