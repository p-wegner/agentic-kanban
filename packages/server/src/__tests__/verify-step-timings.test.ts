// @gate:always-run — the round-trip block below reads the repo's own gate scripts off disk, so
// it asserts a property of the tree that its own imports cannot reach (#988).
/**
 * The `[gate:step]` contract between a verify script and the merge gate (#988).
 *
 * Two properties matter more than the parsing itself: a project that emits NOTHING must reach a
 * silent fallback (that is every project but this one), and a step that ran NARROWED must be
 * unable to render as if it had not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("collapses a repeated name LAST-WINS, keeping its first position", () => {
    // #169's install retry re-runs the whole script into ONE stdout buffer, so a duplicated
    // `tests` is the normal case, not a corruption — and the second run is the one whose cost
    // the verdict describes. Position stays at first appearance because the clause claims to
    // show EXECUTION order: a re-run must not reorder the pipeline it is reporting.
    const steps = parseVerifyStepTimings(
      [
        "[gate:step] name=arch seconds=25",
        "[gate:step] name=tests seconds=118 scope=full",
        "[gate:step] name=tests seconds=131 scope=full",
      ].join("\n"),
    );
    expect(steps.map((s) => s.name)).toEqual(["arch", "tests"]);
    expect(steps.find((s) => s.name === "tests")?.seconds).toBe(131);
  });

  it("a step's own console.log at column 0 cannot append a phantom step", () => {
    // The marker is anchored, so a mid-line mention is already inert — but a suite that ECHOES
    // the contract prints it at column 0, and this repo has exactly such suites. Because the
    // message is PERSISTED as the merge verdict, an injected line must not be able to add a
    // step; the dedup makes the echo collapse onto the real one instead.
    const steps = parseVerifyStepTimings(
      [
        "[gate:step] name=typecheck seconds=35",
        " Test Files  412 passed (412)",
        "[gate:step] name=tests seconds=118 scope=full",
        // a suite printing the contract verbatim as part of its own output
        "[gate:step] name=tests seconds=1",
      ].join("\n"),
    );
    expect(steps.map((s) => s.name)).toEqual(["typecheck", "tests"]);
    expect(steps).toHaveLength(2);
  });

  it("caps the step count, so injected junk cannot grow the persisted message without bound", () => {
    const stdout = Array.from({ length: 40 }, (_, i) => `[gate:step] name=junk${i} seconds=1`).join("\n");
    expect(parseVerifyStepTimings(stdout).length).toBeLessThanOrEqual(8);
  });

  it("still updates an ALREADY-SEEN step past the cap — a real retry is not junk", () => {
    // The cap drops new NAMES, not new values: an install retry's second run arrives after
    // arbitrarily much output, and it must still be able to overwrite its own steps.
    const stdout = [
      ...Array.from({ length: 20 }, (_, i) => `[gate:step] name=junk${i} seconds=1`),
      "[gate:step] name=junk0 seconds=99",
    ].join("\n");
    expect(parseVerifyStepTimings(stdout).find((s) => s.name === "junk0")?.seconds).toBe(99);
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

  it("says which run it describes when a flake retry produced the verdict", () => {
    // The retry reports no steps of its own (a subset's clock would understate the floor), so
    // these belong to the FULL run that FAILED. Unqualified beside a PASSED verdict they read as
    // the cost of the run that passed — the same conflation `+ Ns unaccounted` exists to prevent.
    expect(buildStepTimingNote([{ name: "tests", seconds: 118 }], undefined, true)).toBe(
      "steps: tests 118s, from the run before the retry",
    );
  });

  it("stays unqualified on the ordinary path — the note is for the exceptional case", () => {
    expect(buildStepTimingNote([{ name: "tests", seconds: 118 }], undefined, false)).toBe("steps: tests 118s");
  });
});

/**
 * The two halves of the contract, checked against EACH OTHER (#988).
 *
 * `gate-step-emitters.test.ts` guards that each script still emits a line, but it does so with a
 * substring match on the source — so a drift INSIDE the template passes it while the parser drops
 * the step. `seconds=${n}s` is the concrete case: the guard sees `[gate:step] name=tests seconds=`
 * and is happy, `Number("12s")` is NaN, the step is discarded, and the gate message silently loses
 * a clause. Only realizing the emitter's own template and parsing it catches that.
 */
describe("emitter templates round-trip through the parser (#988)", () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

  /**
   * Pull each `[gate:step] …` template literal out of a script and realize it: every `${…}`
   * substitution becomes a plausible runtime value. `seconds` gets a bare integer (what
   * `Math.round(ms / 1000)` yields) and anything else a word, so the assertion is about the
   * template's SHAPE — the literal text around the holes — which is what can drift.
   */
  function realizedStepLines(rel: string): string[] {
    const source = readFileSync(join(REPO_ROOT, rel), "utf8");
    // `name=` is required in the match, not just `[gate:step]`: each of these files also MENTIONS
    // the marker in backtick-quoted prose ("the `[gate:step]` line the gate parses"), and a doc
    // sentence is not an emitter — matching it would fail this test for a file that is correct.
    return [...source.matchAll(/`(\[gate:step\][^`]*name=[^`]*)`/g)].map(([, template]) =>
      template.replace(/\$\{[^}]*\}/g, (_hole, offset: number) =>
        /seconds=$/.test(template.slice(0, offset)) ? "37" : "somescope",
      ),
    );
  }

  it.each([
    ["scripts/check-arch.mjs", "arch"],
    ["scripts/typecheck.mjs", "typecheck"],
    ["scripts/test-mine.mjs", "tests"],
  ])("%s's emitted line parses back to a step named %s", (rel, stepName) => {
    const lines = realizedStepLines(rel);
    expect(lines, `${rel} has no [gate:step] template literal`).not.toHaveLength(0);
    for (const line of lines) {
      const parsed = parseVerifyStepTimings(line);
      expect(parsed, `${rel} emits \`${line}\`, which the gate's own parser discards`).toHaveLength(1);
      expect(parsed[0].name).toBe(stepName);
      // The number has to survive as a number — this is the `seconds=12.4s` drift the static
      // emitter guard cannot see.
      expect(Number.isFinite(parsed[0].seconds)).toBe(true);
      expect(parsed[0].seconds).toBe(37);
    }
  });

  it("the realizer would CATCH a unit suffix — the failure this test exists for", () => {
    // A negative control: without it, a green above could mean the realizer never substitutes
    // anything and every template trivially "parses".
    expect(parseVerifyStepTimings("[gate:step] name=tests seconds=37s")).toEqual([]);
  });
});
