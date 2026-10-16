import { describe, expect, it } from "vitest";
import {
  buildImplementExitFeedbackPrompt,
  createImplementExitGate,
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

  it("skips impact and full when the host worktree has no deps (a worker built it), not typecheck", () => {
    const plan = planImplementExitRun({ ...base, level: "impact", depsMissing: true });
    expect(plan.kind).toBe("skip");
    expect(plan.kind === "skip" && plan.reason).toContain("ran on a worker");
    expect(planImplementExitRun({ ...base, level: "typecheck", depsMissing: true }).kind).toBe("typecheck");
  });
});

describe("gateImplementExit — #1516 cancels a check the workspace has moved past", () => {
  const ctx = {
    workspace: { id: "ws-1", workingDir: "/wt", baseBranch: "master", parentWorkspaceId: null, forkStatus: null, isDirect: false },
    issueId: "i-1", projectId: "p-1", prefMap: new Map<string, string>(), now: new Date().toISOString(),
  } as unknown as Parameters<ReturnType<typeof createImplementExitGate>>[0];
  const make = (status: string, runCheck: NonNullable<Parameters<typeof createImplementExitGate>[0]["runCheck"]>) => createImplementExitGate({
    database: {} as never,
    boardEvents: { broadcast: () => undefined },
    runCheck,
    resolvePosture: async () => ({ level: "flow", implementExitCheck: "impact" }) as never,
    readWorkflowNode: async () => null,
    listGroupMembers: async () => [],
    readStatus: async () => status,
    watchIntervalMs: 5,
  });

  it("aborts the in-flight check's signal and stops when the workspace is ready_for_merge", async () => {
    let seen: AbortSignal | undefined;
    const gate = make("ready_for_merge", (args) => new Promise((resolve) => {
      seen = args.signal;
      args.signal?.addEventListener("abort", () => resolve({ level: "impact", ran: false, passed: true, held: true, message: "cancelled", failureDetail: null, selectionSize: null, durationMs: 0 }));
    }));
    expect(await gate(ctx)).toBe("stop");
    expect(seen?.aborted).toBe(true);
  });

  it("leaves the check alone while the workspace is still being worked on", async () => {
    const gate = make("idle", async (args) => {
      await new Promise((r) => setTimeout(r, 30));
      expect(args.signal?.aborted).toBe(false);
      return { level: "impact", ran: true, passed: true, held: false, message: "ok", failureDetail: null, selectionSize: 1, durationMs: 1 };
    });
    expect(await gate(ctx)).toBe("proceed");
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
