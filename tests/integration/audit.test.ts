import { describe, expect, it } from "vitest";
import { Client, addDomain, loginAs, makeTestApp } from "../helpers.js";

const PW = "correct horse battery";

type Entry = { action: string; user_id: string | null; user_email: string | null; target: string | null; meta: any; ip: string | null };

describe("audit log", () => {
  it("records sign-ins, password changes, invites, domains and destinations", async () => {
    const t = makeTestApp();
    const admin = new Client(t);
    await admin.post("/v1/auth/setup", { email: "root@example.org", password: PW });
    await new Client(t).post("/v1/auth/login", { email: "root@example.org", password: "wrong-wrong" });
    await new Client(t).post("/v1/auth/login", { email: "nobody@example.org", password: "wrong-wrong" });
    await new Client(t).post("/v1/auth/login", { email: "root@example.org", password: PW });
    await admin.post("/v1/auth/password", { current_password: PW, new_password: "a brand new password" });
    const inv = await admin.post("/v1/admin/invites", { email: "u@example.org" });
    await admin.del(`/v1/admin/invites/${inv.json.invite.id}`);
    const dom = await addDomain(admin);
    await admin.del(`/v1/domains/${dom.id}`);
    const dest = await admin.post("/v1/destinations", { email: "me@elsewhere.example" });
    expect(dest.status).toBe(201);
    await admin.del(`/v1/destinations/${dest.json.destination.id}`);

    const all = (await admin.get("/v1/admin/audit?limit=500")).json;
    const actions = (all.entries as Entry[]).map((e) => e.action);
    for (const a of [
      "user.created_via_setup",
      "auth.login",
      "auth.login_failed",
      "user.password_changed",
      "invite.created",
      "invite.revoked",
      "domain.added",
      "domain.deleted",
      "destination.created",
      "destination.deleted",
    ])
      expect(actions).toContain(a);
    const failed = (all.entries as Entry[]).filter((e) => e.action === "auth.login_failed");
    expect(failed).toHaveLength(2);
    expect(failed.find((e) => e.target === "nobody@example.org")?.user_id).toBeNull();
    expect(failed.find((e) => e.target === "root@example.org")?.user_email).toBe("root@example.org");
    expect(all.actions).toEqual([...new Set(actions)].sort());
  });

  it("filters by action prefix, user and paginates", async () => {
    const t = makeTestApp();
    const admin = await loginAs(t, "admin@example.org", "admin");
    const other = await loginAs(t, "other@example.org", "user");
    for (let i = 0; i < 5; i++) await admin.post("/v1/destinations", { email: `a${i}@elsewhere.example` });
    await other.post("/v1/destinations", { email: "o@elsewhere.example" });
    await new Client(t).post("/v1/auth/login", { email: "x@example.org", password: "nope-nope" });
    const me = (await admin.get("/v1/auth/me")).json.user.id;

    const page1 = (await admin.get(`/v1/admin/audit?action=destination.&user_id=${me}&limit=2`)).json;
    expect(page1.total).toBe(5);
    expect(page1.entries).toHaveLength(2);
    const page3 = (await admin.get(`/v1/admin/audit?action=destination.&user_id=${me}&limit=2&offset=4`)).json;
    expect(page3.entries).toHaveLength(1);
    expect(page3.entries[0].target).not.toBe(page1.entries[0].target);
    expect((await admin.get("/v1/admin/audit?action=destination.created")).json.total).toBe(6);
    expect((await admin.get("/v1/admin/audit?action=auth.")).json.total).toBe(1);
    // A prefix filter does not treat "_" or "%" as wildcards.
    expect((await admin.get("/v1/admin/audit?action=%25.")).json.total).toBe(0);
    expect((await other.get("/v1/admin/audit")).status).toBe(403);
  });
});
