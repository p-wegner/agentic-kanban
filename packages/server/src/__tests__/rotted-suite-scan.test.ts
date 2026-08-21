/**
 * #681 half B — the rot detector and the parser that feeds it.
 *
 * Both halves are pure, which is the whole reason they were split out: the sweep around them
 * needs a database, but "is this suite rotting" and "which suites did this run name" are
 * answerable from a table of cases.
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { createProjectDirectly } from "./helpers/api-test-helpers.js";
import { recordBaseBranchHealth, listSuiteVerdicts } from "../repositories/base-branch-health.repository.js";
import {
  scanRottedSuites,
  findRottedSuites,
  ROTTED_SUITE_MIN_CONSECUTIVE,
  type SuiteVerdict,
} from "../services/rotted-suite-scan.js";
import {
  parseFailedSuites,
  failedSuitesForOutcome,
  outputHasSuiteVerdicts,
} from "../services/failed-suite-parse.js";

/** Newest-first, one hour apart, matching what `listSuiteVerdicts` returns. */
function verdicts(...lists: (string[] | null)[]): SuiteVerdict[] {
  return lists.map((failedSuites, i) => ({
    createdAt: new Date(Date.UTC(2026, 7, 20, 12 - i)).toISOString(),
    failedSuites,
  }));
}

const A = "packages/server/src/__tests__/console-tag-ratchet.test.ts";
const B = "packages/shared/__tests__/codex-skills-parity.test.ts";

describe("findRottedSuites (#681 half B)", () => {
  it("reports a suite red on two consecutive probes", () => {
    const rotted = findRottedSuites(verdicts([A], [A]));
    expect(rotted).toEqual([
      {
        suite: A,
        consecutiveRedProbes: 2,
        redSinceAt: new Date(Date.UTC(2026, 7, 20, 11)).toISOString(),
        lastRedAt: new Date(Date.UTC(2026, 7, 20, 12)).toISOString(),
      },
    ]);
  });

  it("stays silent on a suite red only once — that is a suite someone is mid-fixing", () => {
    expect(findRottedSuites(verdicts([A], []))).toEqual([]);
  });

  it("stops the streak at the first probe where the suite passed", () => {
    const [rotted] = findRottedSuites(verdicts([A], [A], [], [A], [A], [A]));
    expect(rotted.consecutiveRedProbes).toBe(2);
  });

  it("ignores a suite that is green NOW, however long it was red before", () => {
    // A rot list is a to-do, not a history: reporting a repaired suite trains the reader to
    // dismiss the list, which is the failure mode the alarm exists to fix.
    expect(findRottedSuites(verdicts([], [A], [A], [A]))).toEqual([]);
  });

  it("skips a verdict-less probe rather than letting it break a streak", () => {
    // A timeout learned nothing about any suite. Treating it as a pass would silence the
    // alarm exactly when the probe is unhealthy.
    const [rotted] = findRottedSuites(verdicts([A], null, [A]));
    expect(rotted.consecutiveRedProbes).toBe(2);
  });

  it("reports nothing when every probe is verdict-less", () => {
    // Half A's degenerate-distribution alarm is what covers this case; claiming rot from rows
    // that never looked would be the same false verdict in a new place.
    expect(findRottedSuites(verdicts(null, null, null, null))).toEqual([]);
  });

  it("orders longest-rotting first, then by name", () => {
    const rotted = findRottedSuites(verdicts([A, B], [A, B], [A]));
    expect(rotted.map((r) => [r.suite, r.consecutiveRedProbes])).toEqual([[A, 3], [B, 2]]);
  });

  it("needs at least the threshold many conclusive probes to say anything", () => {
    expect(ROTTED_SUITE_MIN_CONSECUTIVE).toBe(2);
    expect(findRottedSuites(verdicts([A]))).toEqual([]);
  });

  it("honours a raised threshold", () => {
    expect(findRottedSuites(verdicts([A], [A]), 3)).toEqual([]);
    expect(findRottedSuites(verdicts([A], [A], [A]), 3)).toHaveLength(1);
  });
});

describe("parseFailedSuites (#681 half B)", () => {
  it("reads vitest's FAIL lines", () => {
    const out = [
      " FAIL  packages/server/src/__tests__/a.test.ts > describe > does a thing",
      " FAIL  packages/server/src/__tests__/a.test.ts > describe > does another",
      " FAIL  packages/shared/__tests__/b.test.ts > x",
    ].join("\n");
    expect(parseFailedSuites(out)).toEqual([
      "packages/server/src/__tests__/a.test.ts",
      "packages/shared/__tests__/b.test.ts",
    ]);
  });

  it("reads the per-file summary marker", () => {
    const out = " ❯ packages/client/src/__tests__/c.test.tsx (12 tests | 3 failed) 412ms";
    expect(parseFailedSuites(out)).toEqual(["packages/client/src/__tests__/c.test.tsx"]);
  });

  it("reads a worker crash's file attribution", () => {
    const out = 'This error originated in "packages/server/src/__tests__/d.test.ts" test file.';
    expect(parseFailedSuites(out)).toEqual(["packages/server/src/__tests__/d.test.ts"]);
  });

  it("never names a PASSING file", () => {
    // The alarm's whole value is that someone acts on the suite it names, so a false name is
    // worse than no name at all.
    const out = [
      " ✓ packages/server/src/__tests__/passing.test.ts (30 tests) 900ms",
      " ↓ packages/server/src/__tests__/skipped.test.ts (2 tests | 2 skipped)",
      " ❯ packages/server/src/__tests__/failing.test.ts (4 tests | 1 failed) 12ms",
    ].join("\n");
    expect(parseFailedSuites(out)).toEqual(["packages/server/src/__tests__/failing.test.ts"]);
  });

  it("normalises Windows separators so the same suite compares equal across probes", () => {
    const out = " FAIL  packages\\server\\src\\__tests__\\e.test.ts > x";
    expect(parseFailedSuites(out)).toEqual(["packages/server/src/__tests__/e.test.ts"]);
  });

  it("returns a sorted, deduped list", () => {
    const out = [" FAIL  z/z.test.ts > a", " FAIL  a/a.test.ts > b", " FAIL  z/z.test.ts > c"].join("\n");
    expect(parseFailedSuites(out)).toEqual(["a/a.test.ts", "z/z.test.ts"]);
  });
});

describe("failedSuitesForOutcome (#681 half B)", () => {
  it("records [] for a green run — the value that BREAKS a red streak", () => {
    expect(failedSuitesForOutcome("green", " Test Files  680 passed (680)")).toEqual([]);
  });

  it("records null for a timeout and for an unverified probe", () => {
    expect(failedSuitesForOutcome("timeout", " FAIL  a/a.test.ts > x")).toBeNull();
    expect(failedSuitesForOutcome("unverified", " FAIL  a/a.test.ts > x")).toBeNull();
  });

  it("records null for a red run that never reached the test runner", () => {
    // A verify script that dies in `tsc` or `check:arch` is red with no suite involved.
    // Storing `[]` for it would clear every streak on a run that exercised no suite at all.
    const tscFailure = "src/foo.ts(3,1): error TS2304: Cannot find name 'bar'.";
    expect(outputHasSuiteVerdicts(tscFailure)).toBe(false);
    expect(failedSuitesForOutcome("red", tscFailure)).toBeNull();
  });

  it("records the parsed list for a red run that did", () => {
    const out = [" FAIL  packages/shared/__tests__/g.test.ts > x", " Test Files  1 failed | 95 passed (96)"].join("\n");
    expect(failedSuitesForOutcome("red", out)).toEqual(["packages/shared/__tests__/g.test.ts"]);
  });

  it("records [] for a red run whose runner named no file", () => {
    // The runner spoke (a `Test Files` line exists) but attributed nothing — an honest empty
    // verdict, distinct from the null above.
    expect(failedSuitesForOutcome("red", " Test Files  96 passed (96)")).toEqual([]);
  });
});

describe("failed_suites round-trips through the column (#681 half B)", () => {
  it("keeps `[]` and `null` distinguishable, because the detector reads them differently", async () => {
    const { db } = createTestDb();
    const projectId = await createProjectDirectly(db, {});
    await recordBaseBranchHealth({ projectId, sha: "s1", branch: "master", outcome: "green", failedSuites: [] }, db);
    await recordBaseBranchHealth({ projectId, sha: "s2", branch: "master", outcome: "timeout", failedSuites: null }, db);
    await recordBaseBranchHealth({ projectId, sha: "s3", branch: "master", outcome: "red", failedSuites: [A] }, db);
    // A row written with no `failedSuites` at all — the shape every pre-#681 row has.
    await recordBaseBranchHealth({ projectId, sha: "s4", branch: "master", outcome: "red" }, db);

    const verdictRows = await listSuiteVerdicts(projectId, 10, db);
    expect(verdictRows.map((r) => r.failedSuites)).toEqual([null, [A], null, []]);
  });

  it("warns for a project whose suite is red across consecutive probes", async () => {
    const { db } = createTestDb();
    const projectId = await createProjectDirectly(db, {});
    await recordBaseBranchHealth({ projectId, sha: "s1", branch: "master", outcome: "red", failedSuites: [A] }, db);
    await recordBaseBranchHealth({ projectId, sha: "s2", branch: "master", outcome: "red", failedSuites: [A, B] }, db);
    await recordBaseBranchHealth({ projectId, sha: "s3", branch: "master", outcome: "red", failedSuites: [A, B] }, db);

    const warnings = await scanRottedSuites(db);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: "rotted_suite", projectId, suiteCount: 2, longestStreakProbes: 3 });
    expect(warnings[0].suites.map((s) => s.suite)).toEqual([A, B]);
    // The message must name the suites — a count alone is not actionable.
    expect(warnings[0].message).toContain(A);
  });

  it("stays silent for a project whose probes are all green", async () => {
    const { db } = createTestDb();
    const projectId = await createProjectDirectly(db, {});
    for (let i = 0; i < 5; i++) {
      await recordBaseBranchHealth({ projectId, sha: `g${i}`, branch: "master", outcome: "green", failedSuites: [] }, db);
    }
    expect(await scanRottedSuites(db)).toEqual([]);
  });

  it("stays silent for a project whose rows predate the column", async () => {
    // Every historical row reads `null`, so the detector has nothing to stand on — and must
    // not manufacture a streak out of rows that never recorded a per-suite verdict.
    const { db } = createTestDb();
    const projectId = await createProjectDirectly(db, {});
    for (let i = 0; i < 5; i++) {
      await recordBaseBranchHealth({ projectId, sha: `r${i}`, branch: "master", outcome: "red" }, db);
    }
    expect(await scanRottedSuites(db)).toEqual([]);
  });
});
