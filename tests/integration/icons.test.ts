import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAs, makeTestApp } from "../helpers.js";
import { iconHost } from "../../app/server/services/icons.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("site icons", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates hosts", () => {
    expect(iconHost("www.GitHub.com")).toBe("github.com");
    expect(iconHost("../etc/passwd")).toBeNull();
    expect(iconHost("localhost")).toBeNull();
    expect(iconHost("a.b/c")).toBeNull();
  });

  it("fetches once through the server, caches on disk, needs a session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-icons-"));
    const t = makeTestApp({ DATA_DIR: dir });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("github.com")) return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect((await t.app.request("/v1/icons/github.com")).status).toBe(401);
    const user = loginAs(t, "u@example.org");
    const a = await user.req("GET", "/v1/icons/github.com");
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("image/png");
    await user.get("/v1/icons/github.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, "icons", "github.com.ico"))).toBe(true);

    expect((await user.get("/v1/icons/unknown.example")).status).toBe(404);
    expect((await user.get("/v1/icons/unknown.example")).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2); // le raté est mémorisé
    expect((await user.get("/v1/icons/not_a_host")).status).toBe(404);
  });
});
