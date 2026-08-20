import { describe, expect, it } from "vitest";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "../services/verify-budget.js";
import { DEFAULT_VERIFY_TIMEOUT_MS } from "../services/pre-merge-gate.service.js";

/**
 * The base probe and the branch gate run the SAME `verify_script`, so they must run it under
 * the SAME budget — that is the premise base-branch-health.service.ts states about itself
 * ("directly comparable"), and it was false: 45 minutes for the base, 20 for the branch.
 *
 * Measured consequence on this board: `verify_timeout|…` merge-backoff on an In-Review branch
 * whose diff was three client files, with the failure text reporting the BASE as already
 * timing out at the merge-base — i.e. both halves timed out, and the branch was charged for it.
 */
describe("verify budget parity", () => {
  it("the gate's default IS the shared verify budget", () => {
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(VERIFY_SCRIPT_TIMEOUT_MS);
  });

  it("the budget exceeds the measured cost of a full run on this repo (~33 min)", () => {
    // A ceiling below the measured cost is not a safety limit, it is a guaranteed timeout.
    expect(VERIFY_SCRIPT_TIMEOUT_MS).toBeGreaterThan(33 * 60 * 1000);
  });
});
