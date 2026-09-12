// @gate:always-run when:scripts/**,packages/server/src/lib/temp-health.ts,packages/server/src/__tests__/helpers/**
/**
 * The pre-merge gate's temp-health floor is stated in TWO places, and they drifted.
 *
 * - `DEFAULT_TEMP_ENTRY_CAP` in `../lib/temp-health.ts` — the AUTHORITY. 250,000, and its own
 *   comment records that a first draft of 50,000 was refuted by measurement within the hour,
 *   because it would hold every merge on a box whose `%TEMP%` enumerates in 0.2 s.
 * - `GATE_TEMP_ENTRY_CAP` in `scripts/sweep-loose-test-db-files.mjs` — the REMEDY script, which
 *   tells an operator whether the remaining entry count still matters.
 *
 * The script had hard-coded the refuted 50,000 and printed "so the gate will keep HOLDING" at
 * any count above it. On a box holding ~82,000 entries that is false twice over: the gate admits
 * (82k is far below 250k), and no hold was occurring. It cost real time — an operator followed
 * that line into hunting a merge blocker that could not exist, while the actual gate failure lay
 * elsewhere. A wrong number in a remedy is worse than no remedy: it is authoritative-looking and
 * it points away from the cause.
 *
 * Why lockstep-by-source rather than a shared import: the same packaging constraint
 * `always-run-dirs-lockstep.test.ts` documents. `scripts/*.mjs` is run by bare `node` with no
 * build step, and `packages/server` ships only `dist/`, so neither side can import the other.
 * Two implementations is the floor the packaging allows — so bind them by BEHAVIOUR.
 *
 * And specifically by reading the SOURCE, never by importing it: that script executes its whole
 * sweep at import time, so an importing guard would enumerate (and with `--apply`, delete in)
 * the developer's real `%TEMP%` as a side effect of running the suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TEMP_ENTRY_CAP } from "../lib/temp-health.js";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SWEEP_SCRIPT = resolve(REPO_ROOT, "scripts/sweep-loose-test-db-files.mjs");

const source = (): string => readFileSync(SWEEP_SCRIPT, "utf8");

/** The literal the script falls back to when `KANBAN_TEMP_ENTRY_CAP` is unset. */
function scriptFallbackCap(src: string): number {
  const m = src.match(/GATE_TEMP_ENTRY_CAP\s*=[\s\S]{0,200}?:\s*([\d_]+)\s*;/);
  if (!m) throw new Error("GATE_TEMP_ENTRY_CAP fallback literal not found in the sweep script");
  return Number(m[1].replaceAll("_", ""));
}

describe("temp-health entry cap: the sweep script mirrors the gate's authority", () => {
  it("the script's fallback cap equals DEFAULT_TEMP_ENTRY_CAP", () => {
    expect(
      scriptFallbackCap(source()),
      "scripts/sweep-loose-test-db-files.mjs restates the gate's temp-health floor. It must equal "
        + "DEFAULT_TEMP_ENTRY_CAP in packages/server/src/lib/temp-health.ts — change both together.",
    ).toBe(DEFAULT_TEMP_ENTRY_CAP);
  });

  it("honours an explicit KANBAN_TEMP_ENTRY_CAP override rather than only the literal", () => {
    // The authority reads the same env key; a remedy that ignored it would disagree with the
    // gate on exactly the boxes where an operator had deliberately retuned the floor.
    expect(source()).toContain("KANBAN_TEMP_ENTRY_CAP");
  });

  it("no longer asserts a hold at the refuted 50,000 threshold", () => {
    const src = source();
    // The specific regression: a >= comparison against the refuted number driving a HOLD claim.
    expect(src).not.toMatch(/remaining\s*>=\s*50_?000/);
    expect(
      /default\s*"?\s*\+?\s*"?\s*50000/.test(src),
      "the script claimed the gate's default floor was 50000; it is DEFAULT_TEMP_ENTRY_CAP",
    ).toBe(false);
  });

  it("states the floor it is comparing against, so the number is checkable in the output", () => {
    // A bare "above/below the floor" line is unfalsifiable by the operator reading it — which is
    // how the wrong threshold survived. The message must carry the value it used.
    expect(source()).toMatch(/\$\{GATE_TEMP_ENTRY_CAP\}/);
  });
});
