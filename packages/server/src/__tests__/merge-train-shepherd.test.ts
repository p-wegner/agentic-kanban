import { describe, expect, it, vi } from "vitest";
import { buildAgentFixBrief, runAgentFix, type AgentFixMember, type TrainAgentRunner } from "../services/merge-train-agent-fix.js";
import { buildConflictBrief, mergeMembersWithShepherd, TrainShepherd, type ShepherdMember } from "../services/merge-train-shepherd.js";
import { decideTrainRedFeedbackTargets } from "../services/merge-train-red-feedback.js";
import type { TrainRunResult } from "../services/merge-train.service.js";
import type { TrainMember } from "../services/merge-train-assembly.js";

const caps = { maxTurns: 4, timeoutMs: 600_000, costCapUsd: 5 };
const m = (n: number, over: Partial<ShepherdMember> = {}): ShepherdMember => ({ workspaceId: `w${n}`, branch: `feature/${n}`, issueNumber: n, title: `Ticket ${n}`, description: `Do thing ${n}`, ...over });

/** A fake runner: records every call and returns one fixed session id. */
const fakeRunner = (calls: Array<Parameters<TrainAgentRunner>[0]> = []): TrainAgentRunner => async (a) => { calls.push(a); return { sessionId: "shepherd-1" }; };

describe("buildAgentFixBrief (#1569)", () => {
  it("carries each member's title, description and changed files; later turns do not repeat them", () => {
    const members: AgentFixMember[] = [m(1, { changedFiles: ["a.ts"] }), m(2)];
    const first = buildAgentFixBrief({ label: "train/x", baseBranch: "main", members, failureMessage: "red", turn: 1 });
    expect(first).toContain("#1 Ticket 1 (feature/1)");
    expect(first).toContain("Do thing 2");
    expect(first).toContain("changed files: a.ts");
    const later = buildAgentFixBrief({ label: "train/x", baseBranch: "main", members, failureMessage: "red", turn: 2 });
    expect(later).not.toContain("Do thing 2");
  });

  it("trims a long description", () => {
    const brief = buildAgentFixBrief({ label: "t", baseBranch: "main", members: [m(1, { description: "x".repeat(5000) })], failureMessage: "red", turn: 1 });
    expect(brief.length).toBeLessThan(2500);
  });
});

describe("mergeMembersWithShepherd (#1569)", () => {
  const setup = (resolves: boolean) => {
    const calls: Array<Parameters<TrainAgentRunner>[0]> = [];
    const shepherd = new TrainShepherd(fakeRunner(calls), "worker-a");
    const conflicting = new Set(["w2", "w3"]);
    const merged: string[] = [];
    const args = {
      label: "train/x", baseBranch: "main", worktree: "/wt", shepherd, caps,
      tryMerge: async (x: ShepherdMember) => conflicting.has(x.workspaceId) ? ({ ok: false as const, detail: "CONFLICT in f.ts", conflictsWith: m(1) }) : (merged.push(x.workspaceId), { ok: true as const }),
      isResolved: async (x: ShepherdMember) => { if (resolves) merged.push(x.workspaceId); return resolves; },
      abortMerge: vi.fn(async () => undefined),
      log: vi.fn(),
    };
    return { args, shepherd, calls, merged };
  };

  it("lands two conflicting members in the same train after the shepherd resolves them", async () => {
    const { args, merged } = setup(true);
    const res = await mergeMembersWithShepherd({ ...args, members: [m(1), m(2), m(3)] });
    expect(res.included.map((x) => x.workspaceId)).toEqual(["w1", "w2", "w3"]);
    expect(res.dropped).toEqual([]);
    expect(merged).toEqual(["w1", "w2", "w3"]);
  });

  it("reuses the same shepherd session for a second conflict and for a red gate", async () => {
    const { args, shepherd, calls } = setup(true);
    await mergeMembersWithShepherd({ ...args, members: [m(1), m(2), m(3)] });
    expect(calls[0].resumeSessionId).toBeUndefined();
    expect(calls[1].resumeSessionId).toBe("shepherd-1");
    expect(calls[0].prompt).toContain("shepherd of merge train");
    expect(calls[1].prompt).not.toContain("Already on the train");
    // the red gate goes to the same session through the shepherd's runner
    shepherd.setAction("fixing gate");
    await shepherd.runner({ worktree: "/wt", prompt: "gate red", timeoutMs: 1000, turn: 3 });
    expect(calls[2].resumeSessionId).toBe("shepherd-1");
    expect(shepherd.status()).toMatchObject({ sessionId: "shepherd-1", worker: "worker-a", turnsUsed: 3, lastAction: "fixing gate" });
  });

  it("defers (with a logged reason) only when the shepherd does not resolve it", async () => {
    const { args } = setup(false);
    const res = await mergeMembersWithShepherd({ ...args, members: [m(1), m(2)] });
    expect(res.included.map((x) => x.workspaceId)).toEqual(["w1"]);
    expect(res.dropped[0]).toMatchObject({ deferred: true });
    expect(res.dropped[0].reason).toContain("did not resolve");
    expect(args.log).toHaveBeenCalledWith(expect.stringContaining("shepherd fallback"));
    expect(args.abortMerge).toHaveBeenCalled();
  });

  it("a worker disconnect is retried and consumes no turn", async () => {
    let n = 0;
    const inner: TrainAgentRunner = async () => {
      if (n++ < 2) throw new Error("fleet worker ao-pf38 disconnected before the one-shot finished");
      return { sessionId: "s2" };
    };
    const shepherd = new TrainShepherd(inner);
    const { args } = setup(true);
    const res = await mergeMembersWithShepherd({ ...args, shepherd, members: [m(1), m(2)] });
    expect(res.included).toHaveLength(2);
    expect(shepherd.turnsUsed).toBe(1);
    expect(shepherd.infraRetries).toBe(2);
    expect(res.held).toBe(false);
  });

  it("holds when the infrastructure keeps failing", async () => {
    const shepherd = new TrainShepherd(async () => { throw new Error("worker disconnected"); });
    const { args } = setup(true);
    const res = await mergeMembersWithShepherd({ ...args, shepherd, members: [m(1), m(2), m(3)] });
    expect(res.held).toBe(true);
    expect(shepherd.turnsUsed).toBe(0);
    expect(res.dropped).toHaveLength(2);
  });

  it("the conflict brief names the rival member", () => {
    expect(buildConflictBrief({ label: "t", baseBranch: "main", member: m(2, { conflictsWith: m(1) }), alreadyOnTrain: [m(1)], detail: "x", first: true })).toContain("collides with #1");
  });
});

describe("runAgentFix with an infrastructure failure (#1569)", () => {
  it("re-places the turn without consuming it, and holds (not red) after the bound", async () => {
    let calls = 0;
    const flaky: TrainAgentRunner = async () => { calls++; throw new Error("fleet worker x disconnected before the one-shot finished"); };
    const out = await runAgentFix({
      worktree: process.cwd(), label: "train/x", baseBranch: "main", members: [m(1)],
      initialFailure: { message: "red" }, caps: { ...caps, maxTurns: 1 }, runAgent: flaky, regate: async () => ({ passed: false, message: "red" }),
      writeBrief: async () => undefined,
    });
    expect(calls).toBe(3);
    expect(out.attempt.verdict).toBe("agent_fix_held");
    expect(out.attempt.agentFix?.turns).toBe(0);
  });
});

describe("red shepherd outcome with no owning member (#1569)", () => {
  it("sends no builder feedback", () => {
    const a = { workspaceId: "a", branch: "f/a", changedFiles: ["p.ts"] } as TrainMember;
    const result = { trainRef: "r", landed: [], dropped: [], gateRejected: [], sided: [], closeFailures: [], gateRuns: 1, attempts: [], redStrategy: "agent-fix", failedSuites: ["elsewhere.test.ts"] } as unknown as TrainRunResult;
    expect(decideTrainRedFeedbackTargets(result, [a])).toEqual([]);
  });
});
