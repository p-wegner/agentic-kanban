import { describe, it, expect } from "vitest";
import { parseDisabledTools, isToolDisabled, withToolDisabled } from "./mcp-tool-toggle.js";

describe("parseDisabledTools", () => {
  it("parses an empty / undefined value to an empty set", () => {
    expect(parseDisabledTools("").size).toBe(0);
    expect(parseDisabledTools(undefined).size).toBe(0);
  });
  it("splits a CSV and drops empty segments", () => {
    expect([...parseDisabledTools("a,b,,c")]).toEqual(["a", "b", "c"]);
  });
});

describe("isToolDisabled", () => {
  it("tests set membership", () => {
    const set = parseDisabledTools("a,b");
    expect(isToolDisabled(set, "a")).toBe(true);
    expect(isToolDisabled(set, "z")).toBe(false);
  });
});

describe("withToolDisabled", () => {
  it("adds a tool to the CSV", () => {
    expect(withToolDisabled(parseDisabledTools("a"), "b", true)).toBe("a,b");
  });
  it("removes a tool from the CSV", () => {
    expect(withToolDisabled(parseDisabledTools("a,b"), "a", false)).toBe("b");
  });
  it("round-trips an emptied set back to '' (not undefined)", () => {
    const result = withToolDisabled(parseDisabledTools("a"), "a", false);
    expect(result).toBe("");
    expect(typeof result).toBe("string");
  });
});
