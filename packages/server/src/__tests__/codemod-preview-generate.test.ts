// @covers codemods.preview.generate [capability,workflow]
// (service-level: previewCodemod() directly; the HTTP route/envelope stays a separate gap)
//
// The headline Codemod-Factory capability: a preview compiles a ts-morph
// transform and returns a REAL per-file diff of the changes it would make,
// while writing nothing to disk. The only pre-existing test
// (packages/e2e/tests/api/codemod.test.ts) is a deliberate no-op that
// tolerates a 500 and only shape-checks the body — a broken transform
// compiler or diff engine would still pass it. This test exercises the
// deterministic supplied-script path (preview accepts a pre-built script, so
// no LLM/claude-cli call is needed) over a small fixture project and asserts
// the actual before/after transform outcome and the unified diff.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewCodemod, CODEMOD_FILE_LIMIT } from "../services/codemod.service.js";

/**
 * A real ts-morph transform (the same shape the LLM is asked to emit: the body
 * of a per-file function receiving `sourceFile`). It renames every class named
 * `Widget` to `Component` via a local AST edit — no regex, no cross-file
 * reference resolution. Files with no matching class are left untouched, which
 * is how the harness detects "no change".
 */
const RENAME_WIDGET_TO_COMPONENT = `
for (const cls of sourceFile.getClasses()) {
  if (cls.getName() === 'Widget') {
    cls.set({ name: 'Component' });
  }
}
`.trim();

describe("codemods.preview.generate — supplied-script preview produces a real transform + diff", () => {
  let repoPath: string;

  // 3 files declare a Widget class (should change) + 1 that doesn't (untouched).
  const CHANGED = ["widget.ts", "widget-two.ts", "widget-three.ts"];
  const UNCHANGED = "unrelated.ts";

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "codemod-preview-gen-"));
    for (const name of CHANGED) {
      await writeFile(
        join(repoPath, name),
        `export class Widget {\n  name = '';\n}\n`,
        "utf8",
      );
    }
    await writeFile(
      join(repoPath, UNCHANGED),
      `export const answer = 42;\n`,
      "utf8",
    );
  });

  afterAll(async () => {
    if (repoPath) await rm(repoPath, { recursive: true, force: true }).catch(() => {});
  });

  it("compiles the transform, diffs only the changed files, and writes nothing", async () => {
    const result = await previewCodemod(RENAME_WIDGET_TO_COMPONENT, repoPath);

    // The supplied script is echoed back verbatim — the LLM path was skipped.
    expect(result.script).toBe(RENAME_WIDGET_TO_COMPONENT);

    // All four fixture files were collected; the small project is under the
    // blast-radius limit so no override was needed.
    expect(result.totalTsFiles).toBe(CHANGED.length + 1);
    expect(result.totalTsFiles).toBeLessThanOrEqual(CODEMOD_FILE_LIMIT);
    expect(result.limitReached).toBe(false);

    // Exactly the three Widget files are reported as changed; the unrelated
    // file is detected as unchanged and omitted.
    expect(result.files).toHaveLength(CHANGED.length);
    const changedRel = result.files.map((f) => f.relativePath).sort();
    expect(changedRel).toEqual([...CHANGED].sort());
    expect(changedRel).not.toContain(UNCHANGED);

    // Each changed file carries a real before/after AND a unified diff that
    // shows the actual edit (Widget -> Component).
    for (const file of result.files) {
      expect(file.original).toContain("class Widget");
      expect(file.original).not.toContain("class Component");

      expect(file.modified).toContain("class Component");
      expect(file.modified).not.toContain("class Widget");

      expect(file.diff).toContain("-export class Widget {");
      expect(file.diff).toContain("+export class Component {");

      // The diff is a non-empty unified diff with a hunk header.
      expect(file.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    }

    // Dry-run guarantee: every fixture on disk is byte-for-byte unchanged.
    for (const name of CHANGED) {
      const onDisk = await readFile(join(repoPath, name), "utf8");
      expect(onDisk).toBe(`export class Widget {\n  name = '';\n}\n`);
    }
    const unrelatedOnDisk = await readFile(join(repoPath, UNCHANGED), "utf8");
    expect(unrelatedOnDisk).toBe(`export const answer = 42;\n`);
  });
});
