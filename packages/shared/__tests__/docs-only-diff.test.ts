import { describe, it, expect } from "vitest";
import { isDocsOnlyDiff, isGuardsOnlyDiff } from "../src/lib/docs-only-diff.js";

describe("isDocsOnlyDiff", () => {
  it("is false for an empty diff (nothing changed is not 'only docs changed')", () => {
    expect(isDocsOnlyDiff([])).toBe(false);
  });

  it("is true when every file is markdown", () => {
    expect(isDocsOnlyDiff(["README.md", "docs/plan.md"])).toBe(true);
  });

  it("is true for documentation under a docs/ directory at any depth", () => {
    expect(isDocsOnlyDiff(["docs/decisions/012-worker-fleet.md", "docs/state.md"])).toBe(true);
  });

  it("is FALSE once a non-documentation file rides along under docs/ (#642)", () => {
    // This assertion used to read `.json` under docs/ as documentation and expect `true` —
    // it pinned the over-match. `docs/verification/*.json` and `docs/domain/_plan.json` are
    // artifacts this repo's code actually reads.
    expect(isDocsOnlyDiff(["docs/decisions/012-worker-fleet.json", "docs/state.md"])).toBe(false);
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

  /**
   * #642 — the same over-matching shape a third time, now in the DIRECTORY rule. It matched a
   * `docs/` segment anywhere in the path with ANY extension, so an executable file merged with
   * no build, no tests and no boot check. This repo really does ship code and live artifacts
   * under `docs/`.
   */
  it.each([
    ["packages/server/src/docs/anything.ts"],
    ["scripts/docs/build.mjs"],
    ["docs/tools/generate.js"],
    ["docs/verification/report.json"],
    ["docs/domain/_plan.json"],
    ["docs/ci/pipeline.yaml"],
    ["docs/migrate.sql"],
    ["docs/setup.sh"],
  ])("is FALSE for the executable/artifact file %s under docs/ (#642)", (file) => {
    expect(isDocsOnlyDiff([file])).toBe(false);
    // …and sitting beside real prose must not launder it.
    expect(isDocsOnlyDiff(["docs/guide.md", file])).toBe(false);
  });

  it("still accepts genuine documentation living under docs/ (#642)", () => {
    expect(isDocsOnlyDiff([
      "docs/guide.md",
      "docs/adr/001.adoc",
      "docs/notes.txt",
      "docs/images/screenshot.png",
      "docs/diagram.svg",
      "docs/NOTES",
    ])).toBe(true);
  });
});

/**
 * #1008 — a diff of board/agent configuration and generated data (plus docs) is not UNKNOWN to
 * the gate: no package suite can import these paths, and the `@gate:always-run` guards are
 * exactly what checks them. Observed on #999: four such files ran the whole server package
 * twice and timed out both times, because the package scoper returned null and null meant
 * "run everything".
 */
describe("isGuardsOnlyDiff (#1008)", () => {
  it("is FALSE for an empty list — an unreadable diff is not a narrow diff", () => {
    expect(isGuardsOnlyDiff([])).toBe(false);
  });

  it("is TRUE for the exact #999 diff", () => {
    expect(isGuardsOnlyDiff([
      ".claude/settings.json",
      ".code-metrics/agent-vocabulary.json",
      ".gitignore",
      "docs/analysis/test-strategy-2026-09-02.md",
    ])).toBe(true);
  });

  it.each([
    [".gitignore"],
    ["packages/server/.gitignore"],
    [".code-metrics/import-graph.json"],
    [".claude/settings.json"],
    [".claude/settings.local.json"],
    [".codex/hooks.json"],
    [".codex/skills/board-navigator/SKILL.md"],
    ["docs/verification/report.json"],
    ["docs/domain/_plan.json"],
    ["README.md"],
  ])("is TRUE for %s", (file) => {
    expect(isGuardsOnlyDiff([file])).toBe(true);
  });

  it("is a superset of docs-only: every docs-only diff is guards-only", () => {
    const docs = ["docs/guide.md", "CHANGELOG", "LICENSE.txt", "docs/images/a.png"];
    expect(isDocsOnlyDiff(docs)).toBe(true);
    expect(isGuardsOnlyDiff(docs)).toBe(true);
  });

  it.each([
    ["packages/server/src/index.ts"],
    [".claude/hooks/validate-command-safety.js"],
    [".claude/skills/foo/tools/run.mjs"],
    ["docs/tools/generate.js"],
    ["docs/ci/pipeline.yaml"],
    ["package.json"],
    ["pnpm-lock.yaml"],
    ["scripts/test-mine.mjs"],
  ])("is FALSE for %s — genuinely un-modelled or code, keeps the full run", (file) => {
    expect(isGuardsOnlyDiff([file])).toBe(false);
    // …and one such file beside modelled ones must not be laundered.
    expect(isGuardsOnlyDiff([".gitignore", file])).toBe(false);
  });

  it("is not docs-only for a config-only diff (the smoke skip stays docs-only)", () => {
    expect(isDocsOnlyDiff([".gitignore", ".claude/settings.json"])).toBe(false);
    expect(isGuardsOnlyDiff([".gitignore", ".claude/settings.json"])).toBe(true);
  });
});
