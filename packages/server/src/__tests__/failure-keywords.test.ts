import { describe, it, expect } from "vitest";
import { extractKeywords } from "@agentic-kanban/shared/lib/failure-keywords";

describe("extractKeywords", () => {
  it("extracts meaningful tokens and lowercases them", () => {
    const kws = extractKeywords("TypeError: Cannot read property");
    expect(kws).toContain("typeerror");
    expect(kws).toContain("cannot");
    expect(kws).toContain("read");
    expect(kws).toContain("property");
  });

  it("filters out stop words", () => {
    const kws = extractKeywords("the a an and or but in on at to for of with by");
    expect(kws).toHaveLength(0);
  });

  it("filters tokens shorter than 3 characters", () => {
    const kws = extractKeywords("ok go do is it");
    expect(kws).toHaveLength(0);
  });

  it("deduplicates tokens", () => {
    const kws = extractKeywords("error error error crash crash");
    const errorCount = kws.filter(k => k === "error").length;
    const crashCount = kws.filter(k => k === "crash").length;
    expect(errorCount).toBe(1);
    expect(crashCount).toBe(1);
  });

  it("replaces non-alphanumeric chars (except _-./)", () => {
    const kws = extractKeywords("module::path/to-file_name.ts");
    expect(kws).toContain("module");
    expect(kws.some(k => k.includes(":"))).toBe(false);
  });

  it("returns empty array for empty string", () => {
    expect(extractKeywords("")).toHaveLength(0);
  });

  it("preserves underscores and hyphens in tokens", () => {
    const kws = extractKeywords("socket_timeout retry-count");
    expect(kws).toContain("socket_timeout");
    expect(kws).toContain("retry-count");
  });

  it("handles numeric tokens", () => {
    const kws = extractKeywords("error code 404 not found");
    expect(kws).toContain("404");
    expect(kws).toContain("error");
    expect(kws).toContain("code");
    expect(kws).toContain("found");
  });
});
