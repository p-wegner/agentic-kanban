import { describe, expect, it } from "vitest";
import { reconcileProgressStepStates } from "../services/plugin-loop-step-state.js";
import type { PluginLoopProgressStep } from "@agentic-kanban/shared/lib/plugin-manifest";

/**
 * #479/#481 — a planner's "generating" means "a ticket exists for this step", not "an agent is
 * live". These pin the three shapes that used to render identically as a running spinner:
 *   - planned, never started (#481): no workspace at all.
 *   - genuinely running: a live workspace.
 *   - exited with no commits (#479): a workspace, but none live — the wedged-forever case.
 */

function step(overrides: Partial<PluginLoopProgressStep> = {}): PluginLoopProgressStep {
  return { id: "step-1", label: "Step 1", state: "generating", ...overrides };
}

describe("reconcileProgressStepStates", () => {
  it("downgrades to 'planned' when the ticket has no workspace at all (#481)", () => {
    const [result] = reconcileProgressStepStates([step()], [
      { externalKey: "plugin-loop:pm:pipeline:step-1", hasAnyWorkspace: false, hasLiveWorkspace: false },
    ]);
    expect(result.state).toBe("planned");
  });

  it("leaves 'generating' alone when a workspace is genuinely live", () => {
    const [result] = reconcileProgressStepStates([step()], [
      { externalKey: "plugin-loop:pm:pipeline:step-1", hasAnyWorkspace: true, hasLiveWorkspace: true },
    ]);
    expect(result.state).toBe("generating");
  });

  it("downgrades to 'stalled' when the workspace exited with no commits and nothing is live (#479)", () => {
    const [result] = reconcileProgressStepStates([step()], [
      { externalKey: "plugin-loop:pm:pipeline:step-1", hasAnyWorkspace: true, hasLiveWorkspace: false },
    ]);
    expect(result.state).toBe("stalled");
  });

  it("matches a ticket's unit id by step-id prefix (versioned unit ids)", () => {
    const [result] = reconcileProgressStepStates([step()], [
      { externalKey: "plugin-loop:pm:pipeline:step-1:v2", hasAnyWorkspace: true, hasLiveWorkspace: false },
    ]);
    expect(result.state).toBe("stalled");
  });

  it("leaves the step untouched when no open ticket matches it", () => {
    const [result] = reconcileProgressStepStates([step()], [
      { externalKey: "plugin-loop:pm:pipeline:step-2", hasAnyWorkspace: true, hasLiveWorkspace: false },
    ]);
    expect(result.state).toBe("generating");
  });

  it("never touches a state other than 'generating'", () => {
    const steps: PluginLoopProgressStep[] = [
      step({ id: "step-1", state: "done" }),
      step({ id: "step-2", state: "pending" }),
      step({ id: "step-3", state: "awaiting-approval" }),
    ];
    const openTickets = [
      { externalKey: "plugin-loop:pm:pipeline:step-1", hasAnyWorkspace: true, hasLiveWorkspace: false },
      { externalKey: "plugin-loop:pm:pipeline:step-2", hasAnyWorkspace: false, hasLiveWorkspace: false },
      { externalKey: "plugin-loop:pm:pipeline:step-3", hasAnyWorkspace: true, hasLiveWorkspace: true },
    ];
    const result = reconcileProgressStepStates(steps, openTickets);
    expect(result.map((s) => s.state)).toEqual(["done", "pending", "awaiting-approval"]);
  });
});
