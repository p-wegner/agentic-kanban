import { describe, expect, it } from "vitest";
import { toPrefMap } from "../src/lib/preference-map.js";

/**
 * #494. The helper is a one-liner, so the only thing worth pinning is the behaviour the
 * doc comment CLAIMS — that it matches the 30 inline `new Map(...)` expressions it replaced,
 * including on a duplicate key. The raw `database.select` call sites do not all read a table
 * with a unique key constraint, so "last row wins" is a real contract, not a triviality.
 */
describe("toPrefMap (#494)", () => {
  it("projects key/value rows into a lookup map", () => {
    const map = toPrefMap([
      { key: "provider", value: "claude" },
      { key: "auto_merge", value: "true" },
    ]);
    expect(map.get("provider")).toBe("claude");
    expect(map.get("auto_merge")).toBe("true");
    expect(map.size).toBe(2);
  });

  it("returns an empty map for no rows rather than throwing", () => {
    expect(toPrefMap([]).size).toBe(0);
  });

  it("lets the LAST row win on a duplicate key, as `new Map(...)` did", () => {
    expect(toPrefMap([
      { key: "provider", value: "claude" },
      { key: "provider", value: "codex" },
    ]).get("provider")).toBe("codex");
  });

  it("preserves an empty-string value instead of dropping the key", () => {
    const map = toPrefMap([{ key: "default_model", value: "" }]);
    expect(map.has("default_model")).toBe(true);
    expect(map.get("default_model")).toBe("");
  });
});
