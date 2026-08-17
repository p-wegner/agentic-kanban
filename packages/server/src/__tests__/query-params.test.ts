import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { queryInt, queryFlag } from "../middleware/query-params.js";

/** Minimal stand-in for the only thing these helpers touch. */
function ctx(params: Record<string, string>): Context {
  return { req: { query: (name: string) => params[name] } } as unknown as Context;
}

describe("queryInt (#511)", () => {
  it("parses a normal value", () => {
    expect(queryInt(ctx({ limit: "7" }), "limit", { def: 3 })).toBe(7);
  });

  it("falls back to the default when absent or empty", () => {
    expect(queryInt(ctx({}), "limit", { def: 3 })).toBe(3);
    expect(queryInt(ctx({ limit: "" }), "limit", { def: 3 })).toBe(3);
    expect(queryInt(ctx({ limit: "   " }), "limit", { def: 3 })).toBe(3);
  });

  it("returns the default instead of NaN for unparseable input", () => {
    // The milestones bug: `parseInt("abc", 10)` is NaN and went straight into the service.
    expect(queryInt(ctx({ days: "abc" }), "days", { def: 30 })).toBe(30);
    expect(Number.isNaN(queryInt(ctx({ days: "abc" }), "days", { def: 30 }))).toBe(false);
  });

  it("preserves an explicit 0 instead of swallowing it", () => {
    // The failure-patterns bug: `parseInt("0", 10) || 3` is 3.
    expect(queryInt(ctx({ limit: "0" }), "limit", { def: 3 })).toBe(0);
  });

  it("clamps to min and max", () => {
    expect(queryInt(ctx({ limit: "999" }), "limit", { def: 3, max: 10 })).toBe(10);
    expect(queryInt(ctx({ limit: "-5" }), "limit", { def: 3, min: 1 })).toBe(1);
    expect(queryInt(ctx({ limit: "5" }), "limit", { def: 3, min: 1, max: 10 })).toBe(5);
  });

  it("clamps the default too, so a bad min/def pairing cannot leak an out-of-range value", () => {
    expect(queryInt(ctx({}), "limit", { def: 0, min: 1 })).toBe(1);
  });
});

describe("queryFlag (#511)", () => {
  it("accepts both wire spellings that were previously split across routes", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(queryFlag(ctx({ force: raw }), "force"), raw).toBe(true);
    }
  });

  it("is false for absent, empty, and non-truthy values", () => {
    expect(queryFlag(ctx({}), "force")).toBe(false);
    expect(queryFlag(ctx({ force: "" }), "force")).toBe(false);
    expect(queryFlag(ctx({ force: "0" }), "force")).toBe(false);
    expect(queryFlag(ctx({ force: "false" }), "force")).toBe(false);
    expect(queryFlag(ctx({ force: "no" }), "force")).toBe(false);
  });
});
