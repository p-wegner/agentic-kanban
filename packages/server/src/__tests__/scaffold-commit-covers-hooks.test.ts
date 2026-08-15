import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DURABLE_CLAUDE_SCAFFOLD_PATHS } from "../services/project-scaffold/commit.js";

/**
 * A hook the scaffold WRITES but the scaffold commit does not COMMIT leaves the main checkout
 * dirty from registration onward, which blocks every later merge with `dirty_main` (#38).
 *
 * That is not hypothetical: `git-topology-cache.js` was added as a load-time dependency of
 * `smart-hooks-runner.js` (#392/#279) and never added to `DURABLE_CLAUDE_SCAFFOLD_PATHS`, so
 * three separate registration tests went red — and stayed red, because `test:mine` is
 * file-scoped and nothing touched those files for weeks.
 *
 * The root cause is a hand-maintained list that has to be updated in lockstep with a different
 * file. This test removes the need to remember: it derives the hooks the scaffold actually
 * resolves from `project-scaffold.ts` and asserts each one is covered by the commit list.
 */
const scaffoldSource = fs.readFileSync(
  path.join(import.meta.dirname!, "..", "services", "project-scaffold.ts"),
  "utf-8",
);

/** Every `resolveHookSource("<name>.js")` the scaffold calls — i.e. every hook it writes. */
function scaffoldedHookFilenames(): string[] {
  const names = new Set<string>();
  for (const m of scaffoldSource.matchAll(/resolveHookSource\(\s*["']([^"']+)["']\s*\)/g)) {
    names.add(m[1]);
  }
  return [...names];
}

describe("scaffold commit covers every hook the scaffold writes (#38)", () => {
  it("finds the scaffold's hook writes at all (guards the guard)", () => {
    // If `resolveHookSource` is ever renamed, the regex above would silently match nothing and
    // this suite would pass vacuously. Assert it still sees the known set.
    const names = scaffoldedHookFilenames();
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toContain("smart-hooks-runner.js");
    expect(names).toContain("git-topology-cache.js");
  });

  it("every scaffolded hook appears in DURABLE_CLAUDE_SCAFFOLD_PATHS", () => {
    const committed = new Set(DURABLE_CLAUDE_SCAFFOLD_PATHS);
    const missing = scaffoldedHookFilenames().filter((name) => !committed.has(`.claude/hooks/${name}`));
    expect(
      missing,
      "These hooks are written into a registered project but never committed, so registration " +
        "leaves the main checkout dirty and every later merge fails with dirty_main (#38). Add " +
        `.claude/hooks/<name> to DURABLE_CLAUDE_SCAFFOLD_PATHS in project-scaffold/commit.ts:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
