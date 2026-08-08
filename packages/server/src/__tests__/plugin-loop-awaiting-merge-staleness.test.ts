/**
 * #353 — a landed earlier step kept claiming the "waiting for merge / Merge now" banner forever.
 *
 * `#326` removed the contradiction of a Merge-now banner rendered directly above a gate card for
 * the SAME unit, reasoning that a gate means the planner has already SEEN that unit's artifacts in
 * the main checkout. But it compared only against the CURRENT gate's id, so a unit from an earlier
 * step never aged out. Measured on `kassenbuch`: step 1's long-merged workspace
 * (`3b69a79 Merge branch '…ak-1…'`, clean tree, planner reporting step-1 `done`) still surfaced as
 * `awaitingMerge` while the pipeline sat at the step-3 gate — and nothing would ever have retired
 * it for the six remaining steps.
 *
 * The unit here is the pure decision function, deliberately: it is the whole defect, and testing it
 * directly avoids asserting on the plugin engine's DB surface for a rule that touches neither.
 */
import { describe, expect, it } from "vitest";
import { isLoopUnitAccountedForByPlanner } from "../services/plugin-loop.service.js";
import type { PluginLoopGate, PluginLoopProgressStep } from "@agentic-kanban/shared/lib/plugin-manifest";

const gate = (id: string): PluginLoopGate => ({
  id,
  question: "Approve?",
  actions: [{ id: "approve", label: "Approve" }],
} as PluginLoopGate);

const steps = (...entries: Array<[string, PluginLoopProgressStep["state"]]>): { steps: PluginLoopProgressStep[] } => ({
  steps: entries.map(([id, state]) => ({ id, label: id, state })),
});

describe("#353: awaitingMerge staleness covers every step the planner reports done", () => {
  it("retires the CURRENT gate's unit (the #326 rule, unchanged)", () => {
    expect(isLoopUnitAccountedForByPlanner("step-3:v1", gate("step-3:v1"), null)).toBe(true);
  });

  it("retires an EARLIER step's unit once the planner reports it done — the actual #353 bug", () => {
    // The exact observed shape: pipeline at the step-3 gate, step 1 long merged and reported done.
    const progress = steps(["step-1", "done"], ["step-2", "done"], ["step-3", "pending"]);
    expect(isLoopUnitAccountedForByPlanner("step-1:v1", gate("step-3:v1"), progress)).toBe(true);
    expect(isLoopUnitAccountedForByPlanner("step-2:v1", gate("step-3:v1"), progress)).toBe(true);
  });

  it("does NOT retire a unit whose step is not done — hiding real unmerged work is #336's failure", () => {
    const progress = steps(["step-1", "done"], ["step-4", "pending"], ["step-5", "needs-revision"]);
    expect(isLoopUnitAccountedForByPlanner("step-4:v1", gate("step-3:v1"), progress)).toBe(false);
    expect(isLoopUnitAccountedForByPlanner("step-5:v2", gate("step-3:v1"), progress)).toBe(false);
    // A step the planner does not mention at all is not evidence of anything.
    expect(isLoopUnitAccountedForByPlanner("step-9:v1", gate("step-3:v1"), progress)).toBe(false);
  });

  it("works with no gate at all (a converged or between-gates loop)", () => {
    expect(isLoopUnitAccountedForByPlanner("step-1:v1", null, steps(["step-1", "done"]))).toBe(true);
    expect(isLoopUnitAccountedForByPlanner("step-1:v1", null, null)).toBe(false);
  });

  it("does not confuse a step id with a longer step id that merely shares its prefix", () => {
    // `step-1` done must not retire a `step-10` unit — the separator is load-bearing.
    const progress = steps(["step-1", "done"]);
    expect(isLoopUnitAccountedForByPlanner("step-10:v1", null, progress)).toBe(false);
    expect(isLoopUnitAccountedForByPlanner("step-1", null, progress)).toBe(true);
  });
});
