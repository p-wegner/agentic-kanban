import { describe, expect, it } from "vitest";
import {
  buildImplementExitFeedbackPrompt,
  decideImplementExitAction,
  IMPLEMENT_EXIT_MAX_FEEDBACK_TURNS,
  isImplementPhaseExit,
} from "./implement-exit-check.js";
import { planImplementExitRun, type ImplementExitCheckResult } from "../../services/implement-exit-check.service.js";

describe("decideImplementExitAction — what the board does with an implement-exit verdict", () => {
  it("green launches review regardless of earlier feedback turns", () => {
    expect(decideImplementExitAction({ passed: true }, 0)).toBe("launch-review");
    expect(decideImplementExitAction({ passed: true }, 5)).toBe("launch-review");
  });

  it("red sends feedback until the cap, then asks for attention", () => {
    expect(IMPLEMENT_EXIT_MAX_FEEDBACK_TURNS).toBe(2);
    expect(decideImplementExitAction({ passed: false }, 0)).toBe("feedback");
    expect(decideImplementExitAction({ passed: false }, 1)).toBe("feedback");
    expect(decideImplementExitAction({ passed: false }, 2)).toBe("needs-attention");
    expect(decideImplementExitAction({ passed: false }, 0, 0)).toBe("needs-attention");
  });
});

describe("isImplementPhaseExit — which builder exits end an implementation phase", () => {
  it("no workflow node, the start node and an in-progress stage are implementation", () => {
    expect(isImplementPhaseExit(null)).toBe(true);
    expect(isImplementPhaseExit({ nodeType: "start", statusName: "In Progress" })).toBe(true);
    expect(isImplementPhaseExit({ nodeType: "normal", statusName: "In Progress" })).toBe(true);
  });

  it("a review-stage node and a terminal node run no check", () => {
    expect(isImplementPhaseExit({ nodeType: "normal", statusName: "In Review" })).toBe(false);
    expect(isImplementPhaseExit({ nodeType: "end", statusName: "Done" })).toBe(false);
  });
});

describe("planImplementExitRun — what one check executes", () => {
  const base = { workingDir: "/wt", typecheckCommand: "pnpm typecheck", verifyScript: "pnpm verify" };

  it("none and a missing worktree skip visibly", () => {
    expect(planImplementExitRun({ ...base, level: "none" }).kind).toBe("skip");
    expect(planImplementExitRun({ ...base, level: "impact", workingDir: null })).toEqual({ kind: "skip", reason: "the workspace has no worktree" });
  });

  it("typecheck runs the typecheck command, and skips with a reason when there is none", () => {
    expect(planImplementExitRun({ ...base, level: "typecheck" })).toEqual({ kind: "typecheck", command: "pnpm typecheck" });
    expect(planImplementExitRun({ ...base, level: "typecheck", typecheckCommand: " " })).toEqual({ kind: "skip", reason: "the project has no typecheck command" });
  });

  it("impact and full run the verify script with the matching gate strategy", () => {
    expect(planImplementExitRun({ ...base, level: "impact" })).toEqual({ kind: "verify", strategy: "impact", command: "pnpm verify" });
    expect(planImplementExitRun({ ...base, level: "full" })).toEqual({ kind: "verify", strategy: "full", command: "pnpm verify" });
    expect(planImplementExitRun({ ...base, level: "full", verifyScript: null }).kind).toBe("skip");
  });
});

describe("buildImplementExitFeedbackPrompt", () => {
  it("names the failures, the attempt and the cap", () => {
    const result: ImplementExitCheckResult = {
      level: "impact", ran: true, passed: false, held: false,
      message: "implement-exit check FAILED (impact selection of 3 test file(s), 1 failing suite(s))",
      failureDetail: "Failing suites:\n- packages/server/src/x.test.ts",
      selectionSize: 3, durationMs: 1000,
    };
    const prompt = buildImplementExitFeedbackPrompt({ result, postureLevel: "flow", attempt: 1, cap: 2 });
    expect(prompt).toContain("packages/server/src/x.test.ts");
    expect(prompt).toContain("feedback turn 1 of 2");
    expect(prompt).toContain("posture `flow`, check `impact`");
  });
});
