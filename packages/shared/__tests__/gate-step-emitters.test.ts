// @gate:always-run — reads the repo's own gate scripts off disk; imports nothing it checks (#988).
/**
 * The EMITTING half of the `[gate:step]` contract (#988).
 *
 * `verify-step-timings.test.ts` pins the parser. Nothing pinned the producers, and that is the
 * half that rots silently: a step that stops printing its line does not fail anything — the gate
 * message simply loses a clause, and its absence reads as "this project does not report steps"
 * rather than "this emitter broke". The parse is fail-open by design, so it can never be the
 * thing that notices.
 *
 * This is deliberately a STATIC check rather than a run of the three commands. Running them
 * would cost the very minutes this ticket exists to measure, and the property worth guarding is
 * that each script still emits SOMETHING in the agreed shape — not what the number is.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** The same anchored shape `parseVerifyStepTimings` accepts, applied to the emitting template. */
const EMITS = /\[gate:step\]\s+name=/;

describe("every step of this repo's verify_script emits its own duration (#988)", () => {
  it.each([
    ["scripts/check-arch.mjs", "arch"],
    ["scripts/typecheck.mjs", "typecheck"],
    ["scripts/test-mine.mjs", "tests"],
  ])("%s emits a `[gate:step] name=%s` line", (file, stepName) => {
    const source = read(file);
    expect(source, `${file} no longer emits a [gate:step] line — the gate message loses this step silently`).toMatch(EMITS);
    expect(source).toContain(`[gate:step] name=${stepName} seconds=`);
  });

  it("the verify_script this repo's gate runs is still the three steps that emit", () => {
    // The contract is per-STEP, so it only covers the floor if the gate's command is still made
    // of the steps that report. A fourth step added to the chain without an emitter would leave
    // its cost inside the `unaccounted` tail rather than being named — visible, but only to a
    // reader who does the subtraction.
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["check:arch"]).toBe("node scripts/check-arch.mjs");
    expect(scripts["typecheck"]).toBe("node scripts/typecheck.mjs");
    expect(scripts["test:mine"]).toBe("node scripts/test-mine.mjs");
  });

  it("check:arch keeps running all three sub-steps — #988 declined to scope it", () => {
    // The ticket MEASURED scoping the dependency-cruiser run and rejected it: the layering rules
    // are about EDGES, and an edge from an unchanged file into a changed one is exactly what a
    // changed-file list hides. Turning `check-arch.mjs` into a script is what made it easy to
    // quietly narrow, so the decision is pinned here rather than left in a comment.
    const source = read("scripts/check-arch.mjs");
    for (const sub of ["check-god-modules.mjs", "lint:arch", "mcp-catalog-parity.test.ts"]) {
      expect(source, `check:arch no longer runs ${sub}`).toContain(sub);
    }
  });
});
