// @covers platform.testing.fixtures [regression-guard]
// @gate:always-run — scans the __tests__ tree for the /repo-lock hang pattern; imports nothing it checks (#538).
/**
 * No NEW test suite may drive the real merge/repo-lock path against `repoPath: "/repo"` (#273).
 *
 * `tryAcquireRepoLock` refuses a repoPath with no `.git` and then POLLS, so a suite that seeds
 * that literal AND reaches the real lock does not fail — it burns its full timeout, every test,
 * on any clean machine and in CI. Two suites (#264, #221) passed for months only because an
 * earlier run had leaked a real `C:\repo\.git` onto the dev machine; when that was removed, 94
 * tests across 14 files went red at once. They had been dead weight the whole time, and nothing
 * in the suite said so — a hang reads as "slow", not as "broken".
 *
 * The fix for those files was `makeTempRepo()` (helpers/temp-repo.ts). This guard is what stops
 * the pattern coming back: the literal stays perfectly fine in the ~30 suites that fully mock
 * git and never reach the lock, so the rule is not "never write /repo" — it is "not while also
 * driving the merge path".
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = join(import.meta.dirname);

/** Imports/identifiers that mean this suite can reach the REAL repo lock. */
const REACHES_REAL_LOCK = /createWorkspaceMergeService|tryAcquireRepoLock|acquireOnDiskRepoLock|from "@agentic-kanban\/shared\/lib\/repo-lock"/;

const REPO_LITERAL = /repoPath:\s*"\/repo"/;

describe("repoPath literal ratchet (#273)", () => {
  it("no suite seeds repoPath \"/repo\" while driving the real merge path", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(TESTS_DIR)) {
      // This file states both patterns in order to look for them.
      if (!name.endsWith(".test.ts") || name === "repo-path-literal-ratchet.test.ts") continue;
      const source = readFileSync(join(TESTS_DIR, name), "utf8");
      if (REPO_LITERAL.test(source) && REACHES_REAL_LOCK.test(source)) offenders.push(name);
    }

    expect(
      offenders,
      `These suites seed repoPath: "/repo" AND reach the real repo lock, so every test in them ` +
        `will hang for its full timeout on a machine without a stray C:\\repo\\.git. ` +
        `Use makeTempRepo() from ./helpers/temp-repo.js instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
