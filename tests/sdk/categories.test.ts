import { describe, expect, it } from "vitest";
import { sdkFixture } from "./setup.js";

describe("SDK: categories, smart folders, directories", () => {
  it("supports categories CRUD and reorder", async () => {
    const { tm } = await sdkFixture();
    const a = await tm.categories.create({ name: "Work", color: "blue", autoMatch: "jira, slack" });
    const b = await tm.categories.create({ name: "Games" });
    expect(a).toMatchObject({ name: "Work", color: "blue", auto_match: "jira, slack", pinned: false });

    const upd = await tm.categories.update(b.id, { name: "Gaming", pinned: true, retentionDays: 30 });
    expect(upd).toMatchObject({ name: "Gaming", pinned: true, retention_days: 30 });

    await tm.categories.reorder([b.id, a.id]);
    const order = (await tm.categories.list()).map((c) => c.id);
    expect(order).toEqual([b.id, a.id]);

    await tm.categories.delete(a.id);
    expect((await tm.categories.list()).map((c) => c.name)).toEqual(["Gaming"]);
    await expect(tm.categories.delete(a.id)).rejects.toMatchObject({ status: 404 });
  });

  it("manages smart folders and directories", async () => {
    const { tm } = await sdkFixture();
    const f = await tm.smartFolders.create("With codes", { has_code: "true" });
    expect(await tm.smartFolders.list()).toEqual([f]);
    await tm.smartFolders.delete(f.id);
    expect(await tm.smartFolders.list()).toEqual([]);

    const d = await tm.directories.create("myname");
    expect(d.name).toBe("myname");
    expect((await tm.directories.list()).map((x) => x.id)).toEqual([d.id]);
    await tm.directories.delete(d.id);
  });

  it("exports and re-imports", async () => {
    const { tm } = await sdkFixture();
    await tm.addresses.create({ siteName: "Site", category: "Misc", createCategory: true });
    const data = await tm.account.export();
    expect(data.categories.map((c) => c.name)).toEqual(["Misc"]);
    const r = await tm.account.import(data);
    expect(r).toMatchObject({ categories_created: 0, addresses_created: 0 });
    expect(r.skipped[0]?.reason).toBe("already exists");
  });
});
