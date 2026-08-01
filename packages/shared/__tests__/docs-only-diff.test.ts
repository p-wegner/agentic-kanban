import { describe, it, expect } from "vitest";
import { isDocsOnlyDiff } from "../src/lib/docs-only-diff.js";

describe("isDocsOnlyDiff", () => {
  it("is false for an empty diff (nothing changed is not 'only docs changed')", () => {
    expect(isDocsOnlyDiff([])).toBe(false);
  });

  it("is true when every file is markdown", () => {
    expect(isDocsOnlyDiff(["README.md", "docs/plan.md"])).toBe(true);
  });

  it("is true for files anywhere under a docs/ directory regardless of extension", () => {
    expect(isDocsOnlyDiff(["docs/decisions/012-worker-fleet.json", "docs/state.md"])).toBe(true);
  });

  it("is true for root LICENSE/CHANGELOG/NOTICE/CONTRIBUTING files", () => {
    expect(isDocsOnlyDiff(["LICENSE", "CHANGELOG.md", "NOTICE", "CONTRIBUTING.md"])).toBe(true);
  });

  it("is false when any file is a source file, even alongside docs", () => {
    expect(isDocsOnlyDiff(["README.md", "src/index.ts"])).toBe(false);
  });

  it("is false when any file is a build file", () => {
    expect(isDocsOnlyDiff(["docs/state.md", "build.gradle.kts"])).toBe(false);
  });

  it("handles Windows-style backslash paths", () => {
    expect(isDocsOnlyDiff(["docs\\state.md", "docs\\decisions\\001.md"])).toBe(true);
  });
});
