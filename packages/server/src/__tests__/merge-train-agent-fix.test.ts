import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import type { MergeTrainAttemptDto } from "@agentic-kanban/shared/types";
import { runMergeTrain, type TrainGate } from "../services/merge-train.service.js";
import { buildAgentFixBrief, runAgentFix, type TrainAgentRunner } from "../services/merge-train-agent-fix.js";

/**
 * #1277 — the in-train fix agent. Real git underneath (the fix lands as commits on the train
 * ref), the agent and the gate injected.
 */
let repo: string;
const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });
const commit = (msg: string) => git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg]);

async function commitOn(branch: string, file: string, content: string) {
  await git(["checkout", "-q", branch]);
  writeFileSync(join(repo, file), content, "utf8");
  await git(["add", file]);
  await commit(`feat: ${file}`);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-fix-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await commit("chore: base");
  await git(["branch", "f1"]);
  await git(["branch", "f2"]);
  await commitOn("f1", "a.txt", "a\n");
  await commitOn("f2", "b.txt", "b\n");
  await git(["checkout", "-q", "main"]);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

const members = [
  { workspaceId: "w1", branch: "f1", issueNumber: 1 },
  { workspaceId: "w2", branch: "f2", issueNumber: 2 },
];
const caps = { maxTurns: 1, timeoutMs: 60_000, costCapUsd: 2 };
const failure = { message: "FAIL issue-form-duplication-ratchet.test.ts\n1 failed", failedSuites: ["issue-form-duplication-ratchet.test.ts"] };

/** An agent that writes `fix.txt` into the worktree (and optionally commits it). */
const writingAgent = (opts: { commit?: boolean } = {}): TrainAgentRunner => async ({ worktree }) => {
  writeFileSync(join(worktree, "fix.txt"), "fixed\n", "utf8");
  if (opts.commit) {
    await gitExecOrThrow(["add", "fix.txt"], { cwd: worktree });
    await gitExecOrThrow(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: agent"], { cwd: worktree });
  }
  return { sessionId: "sess-1" };
};

describe("buildAgentFixBrief", () => {
  it("names the suites, the output tail, the members and the scope", () => {
    const brief = buildAgentFixBrief({ label: "train/x", baseBranch: "main", members, failedSuites: failure.failedSuites, failureMessage: failure.message, turn: 1 });
    expect(brief).toContain("issue-form-duplication-ratchet.test.ts");
    expect(brief).toContain("1 failed");
    expect(brief).toContain("#1 (f1)");
    expect(brief).toContain("#2 (f2)");
    expect(brief).toMatch(/do not revert/i);
    expect(brief).toMatch(/only inside this directory/i);
  });
});

describe("runAgentFix", () => {
  it("goes green: the agent's work is committed and the re-gate's tip is returned", async () => {
    const regate = vi.fn().mockResolvedValue({ passed: true, message: "ok" });
    const out = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps, runAgent: writingAgent(), regate, writeBrief: async () => "file:///brief.md" });

    expect(regate).toHaveBeenCalledTimes(1);
    expect(out.fixedTrainSha).toBe(await revParse(repo, "HEAD"));
    expect(out.attempt).toMatchObject({
      kind: "agent_fix", label: "train/xf", verdict: "agent_fix_green", gateRuns: 1,
      agentFix: { outcome: "green", sessionId: "sess-1", briefUrl: "file:///brief.md" },
    });
    expect(out.attempt.agentFix?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("a red re-gate is a red row and keeps no fixed sha", async () => {
    const regate = vi.fn().mockResolvedValue({ passed: false, message: "still red", failedSuites: ["x.test.ts"] });
    const out = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps, runAgent: writingAgent({ commit: true }), regate });
    expect(out.fixedTrainSha).toBeUndefined();
    expect(out.attempt).toMatchObject({ verdict: "agent_fix_red", failureHead: "still red", agentFix: { outcome: "red" } });
    expect(out.lastGate?.message).toBe("still red");
  });

  it("an agent that changes nothing is capped, and no gate is spent", async () => {
    const regate = vi.fn();
    const out = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps, runAgent: async () => ({}), regate });
    expect(regate).not.toHaveBeenCalled();
    expect(out.attempt).toMatchObject({ verdict: "agent_fix_capped", gateRuns: 0, agentFix: { outcome: "capped", capped: "no-change" } });
  });

  it("a timed-out agent trips the timeout cap", async () => {
    const runAgent: TrainAgentRunner = async () => { throw new Error("Command failed: timed out after 5ms (killed with SIGTERM)"); };
    const out = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps, runAgent, regate: vi.fn() });
    expect(out.attempt).toMatchObject({ verdict: "agent_fix_capped", agentFix: { outcome: "capped", capped: "timeout" } });
  });

  it("an agent that cannot run is a red row, not a throw", async () => {
    const runAgent: TrainAgentRunner = async () => { throw new Error("exited 1 — stderr: not logged in"); };
    const out = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps, runAgent, regate: vi.fn() });
    expect(out.attempt).toMatchObject({ verdict: "agent_fix_red", failureHead: expect.stringContaining("not logged in") });
  });

  it("trips the cost cap when the runner reports usage over it", async () => {
    const runAgent: TrainAgentRunner = async ({ worktree }) => {
      writeFileSync(join(worktree, "fix.txt"), "x", "utf8");
      return { costUsd: 3.5, tokens: 1000 };
    };
    const regate = vi.fn();
    const out = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps, runAgent, regate });
    expect(regate).not.toHaveBeenCalled();
    expect(out.attempt).toMatchObject({ verdict: "agent_fix_capped", agentFix: { capped: "cost", costUsd: 3.5, tokens: 1000 } });
  });

  it("spends no more turns than the cap allows, re-gating between them", async () => {
    let turn = 0;
    let fileSeq = 0;
    const runAgent: TrainAgentRunner = async ({ worktree }) => {
      turn++;
      writeFileSync(join(worktree, `fix${++fileSeq}.txt`), "x", "utf8");
      return {};
    };
    const regate = vi.fn().mockResolvedValueOnce({ passed: false, message: "red 1" }).mockResolvedValueOnce({ passed: true, message: "ok" });
    const out = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps: { ...caps, maxTurns: 2 }, runAgent, regate });
    expect(turn).toBe(2);
    expect(out.attempt.verdict).toBe("agent_fix_green");

    turn = 0;
    const redForever = vi.fn().mockResolvedValue({ passed: false, message: "red" });
    const out2 = await runAgentFix({ worktree: repo, label: "train/x", baseBranch: "main", members, initialFailure: failure, caps: { ...caps, maxTurns: 2 }, runAgent, regate: redForever });
    expect(turn).toBe(2);
    expect(redForever).toHaveBeenCalledTimes(2);
    expect(out2.attempt.verdict).toBe("agent_fix_red");
  });
});

/** The gate port as `runTrainStagingGate` presents it after a fix agent ran on the train ref. */
function fixAttempt(verdict: MergeTrainAttemptDto["verdict"], label: string): MergeTrainAttemptDto {
  return {
    kind: "agent_fix", label: `${label}f`, members: ["w1", "w2"], included: ["w1", "w2"], dropped: [],
    gateStartedAt: new Date().toISOString(), gateFinishedAt: new Date().toISOString(), gateRuns: 1, verdict,
    agentFix: { outcome: verdict === "agent_fix_green" ? "green" : "red", durationMs: 5 },
  };
}

/** Commit onto the train ref the way the agent does in the gate's worktree: a child of the ref's tip. */
async function commitOnTrainRef(trainRef: string): Promise<string> {
  const tip = await revParse(repo, trainRef);
  const tree = (await git(["rev-parse", `${tip}^{tree}`])).trim();
  const fixSha = (await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit-tree", tree, "-p", tip, "-m", "fix: agent"])).trim();
  await git(["update-ref", `refs/heads/${trainRef}`, fixSha]);
  return fixSha;
}

describe("runMergeTrain — fix agent before bisect (#1277)", () => {
  it("lands the FIXED tree when the re-gate is green: no control arm, no bisect, one extra gate run", async () => {
    let fixSha = "";
    const runGate: TrainGate = vi.fn(async ({ trainRef, label }) => {
      fixSha = await commitOnTrainRef(trainRef);
      return { passed: true, message: "ok after fix", agentFix: { attempt: fixAttempt("agent_fix_green", label), fixedTrainSha: fixSha } };
    });
    const gateBaseAlone = vi.fn();
    const closeMember = vi.fn().mockResolvedValue(undefined);

    const result = await runMergeTrain({ repoPath: repo, baseBranch: "main", members, label: "fx1", runGate, closeMember, gateBaseAlone, redStrategy: "agent-fix-then-bisect" });

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(gateBaseAlone).not.toHaveBeenCalled();
    expect(result.landed.map((m) => m.workspaceId)).toEqual(["w1", "w2"]);
    expect(result.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.redStrategy).toBe("agent-fix-then-bisect");
    // The merge on main carries the agent's commit, and every member is still an ancestor.
    expect(await isAncestor(repo, fixSha, "main")).toBe(true);
    for (const branch of ["f1", "f2"]) expect(await isAncestor(repo, await revParse(repo, branch), "main")).toBe(true);
    expect(closeMember).toHaveBeenCalledTimes(2);
    // The fix agent is its own row, ahead of the landed node, and its re-gate counts as a run.
    expect(result.attempts.map((a) => [a.label, a.verdict])).toEqual([["fx1f", "agent_fix_green"], ["fx1", "landed"]]);
    expect(result.gateRuns).toBe(2);
  }, 240000);

  const redRoot = (verdict: MergeTrainAttemptDto["verdict"]): TrainGate => vi.fn(async ({ trainRef, label }) => {
    const tree = await gitExecOrThrow(["ls-tree", "-r", "--name-only", trainRef], { cwd: repo });
    const red = tree.split(/\r?\n/).includes("b.txt");
    if (!red) return { passed: true, message: "ok" };
    // Only the whole train is given a fix agent (`buildTrainOnRed`); a half is not.
    return label === "fx2"
      ? { passed: false, message: "verify failed: b.txt is red", agentFix: { attempt: fixAttempt(verdict, label) } }
      : { passed: false, message: "verify failed: b.txt is red" };
  });

  it.each([
    ["a red re-gate", "agent_fix_red" as const],
    ["a tripped cap", "agent_fix_capped" as const],
  ])("%s falls back to the bisect, and both the fix attempt and the bisect are recorded", async (_name, verdict) => {
    const runGate = redRoot(verdict);
    const gateBaseAlone = vi.fn().mockResolvedValue({ verdict: "green" as const, gateRuns: 1 });

    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "fx2", runGate, closeMember: vi.fn().mockResolvedValue(undefined),
      gateBaseAlone, redStrategy: "agent-fix-then-bisect",
    });

    expect(gateBaseAlone).toHaveBeenCalledTimes(1);
    expect(result.landed.map((m) => m.workspaceId)).toEqual(["w1"]);
    expect(result.gateRejected.map((r) => r.member.workspaceId)).toEqual(["w2"]);
    const labels = result.attempts.map((a) => [a.label, a.verdict]);
    expect(labels[0]).toEqual(["fx2f", verdict]);
    expect(labels).toEqual(expect.arrayContaining([["fx2", "red"], ["fx2a", "landed"], ["fx2b", "red"]]));
  }, 240000);

  it("`agent-fix` alone: a second red is final — no control arm, no bisect, nothing rejected", async () => {
    const runGate = redRoot("agent_fix_red");
    const gateBaseAlone = vi.fn();

    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "fx2", runGate, closeMember: vi.fn(),
      gateBaseAlone, redStrategy: "agent-fix",
    });

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(gateBaseAlone).not.toHaveBeenCalled();
    expect(result.landed).toEqual([]);
    expect(result.gateRejected).toEqual([]);
    expect(result.gateFailure).toContain("b.txt is red");
    expect(result.attempts.map((a) => a.verdict)).toEqual(["agent_fix_red", "red"]);
  }, 240000);

  it("`bisect` (and an absent strategy) is today's behaviour: the gate hears of no fix agent and the search runs", async () => {
    const runGate = redRoot("agent_fix_red");
    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "fx3", runGate, closeMember: vi.fn().mockResolvedValue(undefined), redStrategy: "bisect",
    });
    expect(result.gateRejected.map((r) => r.member.workspaceId)).toEqual(["w2"]);
    expect(result.attempts.every((a) => a.kind !== "agent_fix")).toBe(true);
  }, 240000);
});
