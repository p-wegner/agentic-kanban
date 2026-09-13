import { describe, expect, it } from "vitest";
import { resolveDriveTierGraphView } from "./driveScopeView.js";

// #1130: a drive planned from its target creates a self-scoped epic with no children,
// which reads as one tier of one issue exactly like a genuinely decomposed one-ticket
// drive. The Drive view must still offer the decompose door in that state, alongside the
// tier graph rather than instead of it — never as a permanent dead end.
describe("resolveDriveTierGraphView", () => {
  it("shows only the empty-scope planner when there are no scoped issues at all", () => {
    const view = resolveDriveTierGraphView(0, false);
    expect(view).toEqual({
      showTierGraph: false,
      showEmptyScopePlanner: true,
      showDecomposeDoor: false,
    });
  });

  it("shows the tier graph AND the decompose door for a self-scoped (planned, undecomposed) epic", () => {
    const view = resolveDriveTierGraphView(1, true);
    expect(view).toEqual({
      showTierGraph: true,
      showEmptyScopePlanner: false,
      showDecomposeDoor: true,
    });
  });

  it("shows only the tier graph for a decomposed drive, even a one-ticket one (#1074)", () => {
    // #1074's "tooSmallToDecompose" property: a right-sized epic still has a progress
    // denominator (1 tier, 1 issue) but is NOT selfScoped once it was genuinely decomposed
    // (or was itself the sole scope by design, not by the no-children fallback).
    const view = resolveDriveTierGraphView(1, false);
    expect(view).toEqual({
      showTierGraph: true,
      showEmptyScopePlanner: false,
      showDecomposeDoor: false,
    });
  });

  it("shows only the tier graph for a multi-tier decomposed drive", () => {
    const view = resolveDriveTierGraphView(3, false);
    expect(view.showTierGraph).toBe(true);
    expect(view.showEmptyScopePlanner).toBe(false);
    expect(view.showDecomposeDoor).toBe(false);
  });
});
