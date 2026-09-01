/**
 * The `[gate:step]` contract between a verify script and the merge gate (#988).
 *
 * Two properties matter more than the parsing itself: a project that emits NOTHING must reach a
 * silent fallback (that is every project but this one), and a step that ran NARROWED must be
 * unable to render as if it had not.
 */
import { describe, it, expect } from "vitest";
import { parseVerifyStepTimings, buildStepTimingNote } from "../services/verify-step-timings.js";

describe("parseVerifyStepTimings", () => {
  it("parses the steps out of a realistic verify stdout", () => {
    const stdout = [
      "[check:arch] 25s total: god-modules 2s, lint:arch 12s, mcp-catalog-parity 11s",
      "[gate:step] name=arch seconds=25",
      "[typecheck] 35s total across 5 package(s), 2 worker(s): server 18s, client 9s",
      "[gate:step] name=typecheck seconds=35",
      "",
      " Test Files  412 passed (412)",
      "[gate:step] name=tests seconds=118 scope=impact-selected",
    ].join("\n");
    expect(parseVerifyStepTimings(stdout)).toEqual([
      { name: "arch", seconds: 25 },
      { name: "typecheck", seconds: 35 },
      { name: "tests", seconds: 118, scope: "impact-selected" },
    ]);
  });

  it("preserves EXECUTION order, not duration order", () => {
    // The steps are a pipeline. `scripts/typecheck.mjs` sorts its packages slowest-first because
    // there the question is "what is the floor made of"; here the question is also "what ran
    // after what", and the seconds already answer the first one.
    const steps = parseVerifyStepTimings("[gate:step] name=arch seconds=25\n[gate:step] name=tests seconds=118");
    expect(steps.map((s) => s.name)).toEqual(["arch", "tests"]);
  });

  it("returns nothing for output that carries no step lines — the fallback every other project takes", () => {
    expect(parseVerifyStepTimings("BUILD SUCCESSFUL in 42s\n> Task :test\n")).toEqual([]);
    expect(parseVerifyStepTimings("")).toEqual([]);
    expect(parseVerifyStepTimings(undefined)).toEqual([]);
    expect(parseVerifyStepTimings(null)).toEqual([]);
  });

  it("drops a malformed line rather than reporting a 0s step", () => {
    // A step claiming 0s reads as "free", which is the flattering direction — the same reason
    // `check-arch.mjs` refuses to emit on its fail-fast path.
    const stdout = [
      "[gate:step] seconds=12",
      "[gate:step] name=typecheck",
      "[gate:step] name=arch seconds=notanumber",
      "[gate:step] name=arch seconds=-3",
      "[gate:step] name=tests seconds=9",
    ].join("\n");
    expect(parseVerifyStepTimings(stdout)).toEqual([{ name: "tests", seconds: 9 }]);
  });

  it("reads a quoted scope, so a multi-word scope survives", () => {
    expect(parseVerifyStepTimings('[gate:step] name=tests seconds=40 scope="3 of 5 packages"')).toEqual([
      { name: "tests", seconds: 40, scope: "3 of 5 packages" },
    ]);
  });

  it("does not match a line that merely mentions the marker inside test output", () => {
    // A verify run's stdout is thousands of lines of assertion diffs. The marker has to be
    // anchored, or a test NAME containing it would inject a fabricated step.
    const stdout = [
      "  ✓ prints [gate:step] name=tests when the run finishes",
      "  AssertionError: expected '[gate:step] name=x seconds=1' to be ''",
    ].join("\n");
    expect(parseVerifyStepTimings(stdout)).toEqual([]);
  });

  it("parses every line — a /g regex's lastIndex must not leak between lines", () => {
    const stdout = Array.from({ length: 4 }, (_, i) => `[gate:step] name=s${i} seconds=${i + 1} scope=full`).join("\n");
    expect(parseVerifyStepTimings(stdout)).toHaveLength(4);
    expect(parseVerifyStepTimings(stdout).every((s) => s.scope === "full")).toBe(true);
  });
});

describe("buildStepTimingNote", () => {
  it("is null when nothing was reported, so the gate message omits the clause", () => {
    expect(buildStepTimingNote([])).toBeNull();
    expect(buildStepTimingNote([], 180_000)).toBeNull();
  });

  it("names each step and its duration", () => {
    expect(
      buildStepTimingNote([
        { name: "arch", seconds: 25 },
        { name: "typecheck", seconds: 35 },
        { name: "tests", seconds: 118 },
      ]),
    ).toBe("steps: arch 25s, typecheck 35s, tests 118s");
  });

  it("names a step's SCOPE — a narrowed step may not read like a full one", () => {
    const note = buildStepTimingNote([
      { name: "typecheck", seconds: 10 },
      { name: "tests", seconds: 40, scope: "guards-only" },
    ]);
    expect(note).toContain("tests 40s (guards-only)");
    // The unscoped step stays unadorned rather than gaining a decorative "(full)".
    expect(note).toContain("typecheck 10s,");
  });

  it("reports the gap between the named steps and the run's wall clock", () => {
    // The parts must never look like they account for the whole run when they do not — the
    // same honesty `PassReport`'s `N unaccounted` applies to a pass that swallowed candidates.
    const note = buildStepTimingNote([{ name: "tests", seconds: 100 }], 130_000);
    expect(note).toBe("steps: tests 100s + 30s unaccounted");
  });

  it("says nothing about a sub-second gap, and never about a negative one", () => {
    expect(buildStepTimingNote([{ name: "tests", seconds: 100 }], 100_400)).toBe("steps: tests 100s");
    // Rounding can make the reported sum exceed the measured wall clock by a second; a
    // "+ -1s unaccounted" would be nonsense, so the tail is omitted rather than negated.
    expect(buildStepTimingNote([{ name: "tests", seconds: 100 }], 99_000)).toBe("steps: tests 100s");
  });

  it("omits the tail entirely when the run was never timed", () => {
    expect(buildStepTimingNote([{ name: "tests", seconds: 100 }])).toBe("steps: tests 100s");
  });
});
