/**
 * #1309 — the suite a crashed vitest worker took with it. Fixture mirrors rc/20261004-6: every
 * reported file passed, the server summary is one file short, and only the run's own worker-exit
 * lines (not app logs) count as a crash.
 */
import { describe, expect, it } from "vitest";
import { findUnreportedSuites, type PackageTestLister } from "../services/verify-unreported-suites.js";

const CRASH = "Error: [vitest-pool]: Worker forks emitted error.\nCaused by: Error: Worker exited unexpectedly";
const run = (crash: string) => [
  "[test:mine] shared: node vitest run --maxWorkers=4",
  " ✓ __tests__/a.test.ts (2 tests) 3ms",
  " Test Files  1 passed (1)",
  "[test:mine] server: node vitest run --exclude **/cli-issue.test.ts --maxWorkers=4",
  " ✓ src/__tests__/one.test.ts (3 tests) 5ms",
  " ↓ src/__tests__/skipped.test.ts (1 test | 1 skipped)",
  crash,
  " Test Files  1 passed | 1 skipped (3)",
].join("\n");

const lister = (files: Record<string, string[]>, seen: string[][] = []): PackageTestLister => (label, excludes) => {
  seen.push([label, ...excludes]);
  return files[label] ?? [];
};

describe("findUnreportedSuites (#1309)", () => {
  it("names exactly the file the crashed worker never reported, asking vitest with the run's own excludes", () => {
    const seen: string[][] = [];
    const suites = findUnreportedSuites(run(CRASH), lister({
      shared: ["__tests__/a.test.ts"],
      server: ["src/__tests__/one.test.ts", "src/__tests__/skipped.test.ts", "src/__tests__/relocate.test.ts"],
    }, seen));
    expect(suites).toEqual([{ packageLabel: "server", file: "src/__tests__/relocate.test.ts" }]);
    expect(seen).toEqual([["server", "**/cli-issue.test.ts"]]);
  });

  it("answers nothing without vitest's own worker-exit report, even if an app log says 'unhandled error'", () => {
    const suites = findUnreportedSuites(run("[server] unhandled error: Error: kaboom"), lister({
      server: ["src/__tests__/one.test.ts", "src/__tests__/skipped.test.ts", "src/__tests__/relocate.test.ts"],
    }));
    expect(suites).toEqual([]);
  });

  it("answers nothing when the missing files cannot be pinned down exactly", () => {
    const suites = findUnreportedSuites(run(CRASH), lister({
      server: ["src/__tests__/one.test.ts", "src/__tests__/skipped.test.ts", "src/__tests__/x.test.ts", "src/__tests__/y.test.ts"],
    }));
    expect(suites).toEqual([]);
  });

  it("answers nothing when the lister cannot tell (vitest list failed)", () => {
    expect(findUnreportedSuites(run(CRASH), lister({}))).toEqual([]);
  });
});
