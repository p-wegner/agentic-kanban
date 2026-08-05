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

  /**
   * #240: the classifier no longer only skips the smoke boot — since 9109ef6b06 a docs-only
   * verdict skips the FULL verify gate, so a false positive lands unverified code. These are
   * the four shapes that used to slip through: a documentation NAME with a CODE extension, and
   * `.txt` files that are dependency manifests / build files rather than prose.
   */
  it.each([
    ["packages/server/src/services/changelog.ts"],
    ["src/notice.py"],
    ["lib/authors.rb"],
    ["app/license.go"],
    ["contributing.tsx"],
    ["requirements.txt"],
    ["CMakeLists.txt"],
  ])("is FALSE for the code/build file %s (#240)", (file) => {
    expect(isDocsOnlyDiff([file])).toBe(false);
    // …and it must not be laundered into docs-only by sitting next to real docs.
    expect(isDocsOnlyDiff(["README.md", file])).toBe(false);
  });

  it("still accepts documentation NAMES with a documentation extension or none", () => {
    expect(isDocsOnlyDiff(["LICENSE", "LICENSE.txt", "CHANGELOG.md", "NOTICE.txt", "AUTHORS", "CONTRIBUTING.rst"])).toBe(true);
  });

  it("still treats a .txt under docs/ as documentation (the directory, not the extension)", () => {
    expect(isDocsOnlyDiff(["docs/notes.txt"])).toBe(true);
  });
});
