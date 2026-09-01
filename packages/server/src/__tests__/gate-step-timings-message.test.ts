/**
 * The gate's one-line verdict names where its time went (#988).
 *
 * #980 made the typecheck half self-reporting, but only into the gate LOG — the verdict itself
 * still said nothing, so the floor had to be re-measured by hand to argue about it. These pin
 * the two halves of the fix that can actually regress: the clause appears when the script
 * reported steps, and it stays SILENT for every project that reported none.
 */
import { describe, it, expect } from "vitest";
import { buildGateTierMessage, type GateTierInfo } from "../services/pre-merge-gate-tier.js";

const base: GateTierInfo = {
  strategy: "full",
  packageScoped: false,
  fileScoped: false,
  changedFileCount: 4,
  guardSuiteCount: 7,
  maxWorkers: 6,
};

describe("the gate message names each verify STEP's duration (#988)", () => {
  it("names the steps in execution order, beside the tier", () => {
    const msg = buildGateTierMessage({
      ...base,
      stepTimings: [
        { name: "arch", seconds: 25 },
        { name: "typecheck", seconds: 35 },
        { name: "tests", seconds: 118 },
      ],
    });
    expect(msg).toContain("tier: full");
    expect(msg).toContain("steps: arch 25s, typecheck 35s, tests 118s");
  });

  it("says nothing when the verify script reported no steps — every non-self project", () => {
    // The fallback has to be SILENT rather than a bare `steps: `: a field that is empty on
    // nearly every gate trains the reader to skip the position it occupies, which is the same
    // argument `queued 0s` and `selector: related` already make for staying quiet.
    for (const tierInfo of [base, { ...base, stepTimings: [] }, { ...base, stepTimings: [], verifyRunMs: 180_000 }]) {
      expect(buildGateTierMessage(tierInfo)).not.toContain("steps:");
    }
  });

  it("names a step that ran SCOPED, so a cheap gate cannot read as a full one", () => {
    // The whole honesty rule in one place: 40s of guards-only tests is not evidence that the
    // test half of the floor is 40s, and a bare `tests 40s` beside `tier: guards-only` would
    // invite exactly that reading.
    const msg = buildGateTierMessage({
      ...base,
      guardsOnly: true,
      stepTimings: [
        { name: "typecheck", seconds: 10 },
        { name: "tests", seconds: 40, scope: "guards-only" },
      ],
    });
    expect(msg).toContain("tier: guards-only");
    expect(msg).toContain("tests 40s (guards-only)");
  });

  it("does not let the named steps stand in for the whole run's clock", () => {
    const msg = buildGateTierMessage({
      ...base,
      stepTimings: [{ name: "tests", seconds: 100 }],
      verifyRunMs: 140_000,
    });
    expect(msg).toContain("steps: tests 100s + 40s unaccounted");
  });

  it("names which run the steps describe when a flake retry produced the verdict", () => {
    // The steps come from the full run that FAILED — the targeted retry reports none of its own.
    // Beside a PASSED verdict they would otherwise read as the cost of the run that passed.
    const msg = buildGateTierMessage({
      ...base,
      flakeRetryNote: "— 1 suite(s) failed under load and PASSED on a targeted re-run: foo.test.ts",
      stepTimings: [{ name: "tests", seconds: 118 }],
    });
    expect(msg).toContain("steps: tests 118s, from the run before the retry");
  });

  it("still carries every pre-existing clause — the step note is additive", () => {
    // The message is the one place several tickets' visibility rules meet, so a new clause
    // that displaced an old one would silently undo another ticket's fix.
    const msg = buildGateTierMessage({
      ...base,
      fileScoped: true,
      buildersQuiesced: true,
      queueWaitMs: 42_000,
      stepTimings: [{ name: "tests", seconds: 9 }],
    });
    expect(msg).toContain("tier: file-scoped");
    expect(msg).toContain("4 changed file(s)");
    expect(msg).toContain("+7 guard suites");
    expect(msg).toContain("workers 6");
    expect(msg).toContain("builders held");
    expect(msg).toContain("queued 42s behind another verification");
    expect(msg).toContain("steps: tests 9s");
  });
});
