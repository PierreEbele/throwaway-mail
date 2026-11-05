import { describe, expect, it } from "vitest";
import { en, fr } from "../../app/web/src/i18n/catalog.js";

type Tree = { [k: string]: unknown };

/** Flattens a catalog into "a.b.c" -> value, so both languages can be compared key by key. */
function flatten(t: Tree, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(t)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") for (const [kk, vv] of flatten(v as Tree, key)) out.set(kk, vv);
    else out.set(key, v);
  }
  return out;
}

describe("web UI catalogs", () => {
  const e = flatten(en as unknown as Tree);
  const f = flatten(fr as unknown as Tree);

  it("have the same keys in English and French", () => {
    expect([...f.keys()].sort()).toEqual([...e.keys()].sort());
  });

  it("have no empty strings and matching entry kinds", () => {
    for (const [k, v] of e) {
      const other = f.get(k);
      expect(typeof other, k).toBe(typeof v);
      if (typeof v === "string") expect(v.length, k).toBeGreaterThan(0);
      if (typeof other === "string") expect(other.length, k).toBeGreaterThan(0);
    }
  });
});
