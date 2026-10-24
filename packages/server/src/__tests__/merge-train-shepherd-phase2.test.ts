import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/index.js";
import { runAgentFix, type TrainAgentRunner } from "../services/merge-train-agent-fix.js";
import { assertTrainPreservesAncestry, trainRefName } from "../services/merge-train-assembly.js";
import { assembleMergeTrainWithShepherd } from "../services/merge-train-incremental-assembly.js";
import { createPlacedSessionRunner, parseOneShotJsonResult } from "../services/merge-train-session-runner.js";
import { describeUnownedTrainRed, decideTrainRedFeedbackTargets } from "../services/merge-train-red-feedback.js";
import { buildTrainOnRed } from "../services/merge-train-shepherd-wiring.js";
import { mergeMembersWithShepherd, TrainShepherd, type ShepherdMember } from "../services/merge-train-shepherd.js";
import { formatShepherdLine } from "../cli/status-console-model.js";
import type { TrainRunResult } from "../services/merge-train.service.js";
import type { TrainMember } from "../services/merge-train-assembly.js";

const caps = { maxTurns: 4, timeoutMs: 600_000, costCapUsd: 5 };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

describe("incremental assembly with the shepherd (#1572)", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ak-train-shepherd-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "g.txt"), "g1\ng2\ng3\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const branchOff = (name: string, file: string, content: string) => {
      git(repo, "checkout", "-q", "-b", name, "main");
      writeFileSync(join(repo, file), content);
      git(repo, "commit", "-qam", name);
    };
    branchOff("feature/1", "f.txt", "one\nTWO-from-1\nthree\n");
    branchOff("feature/2", "f.txt", "one\nTWO-from-2\nthree\n"); // collides with #1
    branchOff("feature/3", "g.txt", "g1\ng2\nG3\n"); // clean
    git(repo, "checkout", "-q", "main");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const members: TrainMember[] = [1, 2, 3].map((n) => ({ workspaceId: `w${n}`, branch: `feature/${n}`, issueNumber: n }));
  const ports = (wtRoot: string) => ({
    createWorktree: async (repoPath: string, ref: string) => {
      const dir = join(wtRoot, "wt");
      git(repoPath, "worktree", "add", "-q", dir, ref);
      return dir;
    },
    removeWorktree: async (repoPath: string, dir: string) => { git(repoPath, "worktree", "remove", "--force", dir); },
  });
  /** A shepherd stand-in: the turn starts from the clean tree (#1711), runs the merge named in the brief itself, keeps both sides. */
  const resolvingRunner = (calls: Array<Parameters<TrainAgentRunner>[0]>): TrainAgentRunner => async (a) => {
    calls.push(a);
    const branch = /git merge --no-ff ([^\s`]+)/.exec(a.prompt)?.[1] as string;
    expect(() => git(a.worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow(); // no merge left pending
    try { git(a.worktree, "-c", "user.email=s@s", "-c", "user.name=s", "merge", "--no-ff", "-q", branch); } catch { /* conflicts: resolved below */ }
    writeFileSync(join(a.worktree, "f.txt"), "one\nTWO-from-1\nTWO-from-2\nthree\n");
    git(a.worktree, "add", "f.txt");
    git(a.worktree, "-c", "user.email=s@s", "-c", "user.name=s", "commit", "--no-edit", "-q");
    return { sessionId: "shepherd-1", tokens: 10, costUsd: 0.1, worker: "worker-a" };
  };

  it("lands two conflicting members in ONE train, with ancestry intact and no deferral", async () => {
    const calls: Array<Parameters<TrainAgentRunner>[0]> = [];
    const shepherd = new TrainShepherd(resolvingRunner(calls));
    const res = await assembleMergeTrainWithShepherd(
      { repoPath: repo, baseBranch: "main", members, label: "train/t-01" },
      { database: {} as Database, shepherd, caps, log: () => undefined, ...ports(root) },
    );
    expect(res.included.map((m) => m.workspaceId).sort()).toEqual(["w1", "w2", "w3"]);
    expect(res.dropped).toEqual([]);
    expect(res.trainSha).toBe(git(repo, "rev-parse", trainRefName("train/t-01")));
    await assertTrainPreservesAncestry(repo, res.trainRef, res.included, "main");
    expect(git(repo, "show", `${res.trainRef}:f.txt`)).toContain("TWO-from-2");
    expect(calls).toHaveLength(1);
    expect(shepherd.toDto()).toMatchObject({ sessionId: "shepherd-1", worker: "worker-a", turns: 1, conflicts: [{ workspaceId: expect.any(String), outcome: "resolved" }] });
    expect(git(repo, "worktree", "list")).not.toContain("wt");
  });

  it("defers a member the shepherd could not resolve and leaves the tree clean for the next one", async () => {
    const shepherd = new TrainShepherd(async () => ({ sessionId: "shepherd-1" })); // does nothing
    const res = await assembleMergeTrainWithShepherd(
      { repoPath: repo, baseBranch: "main", members, label: "train/t-02" },
      { database: {} as Database, shepherd, caps, log: () => undefined, ...ports(root) },
    );
    const droppedIds = res.dropped.map((d) => d.member.workspaceId);
    expect(droppedIds).toHaveLength(1);
    expect(res.dropped[0]).toMatchObject({ deferred: true });
    expect(res.included).toHaveLength(2);
    expect(git(repo, "show", `${res.trainRef}:g.txt`)).toContain("G3");
    expect(shepherd.toDto().conflicts?.[0]).toMatchObject({ outcome: "deferred" });
  });

  it("takes the ref-only path when nothing collides", async () => {
    const shepherd = new TrainShepherd(async () => { throw new Error("must not run"); });
    const res = await assembleMergeTrainWithShepherd(
      { repoPath: repo, baseBranch: "main", members: [members[0], members[2]], label: "train/t-03" },
      { database: {} as Database, shepherd, caps, log: () => undefined, ...ports(root) },
    );
    expect(res.included).toHaveLength(2);
    expect(shepherd.turnsUsed).toBe(0);
  });

  it("a second conflict and a red gate resume ONE session id end to end", async () => {
    const calls: Array<Parameters<TrainAgentRunner>[0]> = [];
    const shepherd = new TrainShepherd(async (a) => { calls.push(a); return { sessionId: "shepherd-1", tokens: 5, costUsd: 0.2 }; });
    const wt = join(root, "wt0");
    mkdirSync(wt);
    git(wt, "init", "-q"); // the gate worktree stand-in: runAgentFix only needs a repo to commit in
    git(wt, "config", "user.email", "t@t");
    git(wt, "config", "user.name", "t");
    writeFileSync(join(wt, "a"), "1");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "init");
    // two conflict turns through the shepherd ...
    await mergeMembersWithShepherd({
      label: "train/x", baseBranch: "main", worktree: wt, shepherd, caps,
      members: [{ workspaceId: "w1", branch: "b1", issueNumber: 1 }, { workspaceId: "w2", branch: "b2", issueNumber: 2 }] as ShepherdMember[],
      tryMerge: async () => ({ ok: false, detail: "CONFLICT" }),
      isResolved: async () => true, abortMerge: async () => undefined, log: () => undefined,
    });
    // ... then the red gate, through the same shepherd runner
    const onRed = buildTrainOnRed({
      policy: { strategy: "agent-fix", agentFix: true, bisectAfter: false, caps } as never,
      shepherd, label: "train/x", attemptLabel: "train/x", baseBranch: "main",
      included: [{ workspaceId: "w1" }], members: [{ workspaceId: "w1", branch: "b1", issueNumber: 1 }],
      database: {} as Database, placement: { projectId: "p", repoPath: repo },
    })!;
    let regates = 0;
    const out = await onRed({
      gateWorktree: wt, message: "FAIL suite", failedSuites: ["x.test.ts"],
      regate: async () => { regates++; return { passed: true, message: "ok" }; },
    }).catch(() => null);
    // the stand-in made no commit, so the fix reports "no change" - what matters is the runner traffic
    expect(out).not.toBeNull();
    expect(calls.map((c) => c.resumeSessionId)).toEqual([undefined, "shepherd-1", "shepherd-1"]);
    expect(shepherd.toDto().sessionId).toBe("shepherd-1");
    expect(calls[2].prompt).toContain("unchanged since your first brief");
    expect(regates).toBe(0);
  });
});

describe("the placed session runner (#1572)", () => {
  it("parses claude's JSON result into session id, tokens and cost", () => {
    const out = parseOneShotJsonResult(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "abc", total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 9999 } }));
    expect(out).toEqual({ text: "done", sessionId: "abc", tokens: 125, costUsd: 0.42 });
    expect(parseOneShotJsonResult("plain text answer")).toBeNull();
    expect(() => parseOneShotJsonResult(JSON.stringify({ type: "result", is_error: true, result: "boom" }))).toThrow(/boom/);
  });

  it("reports usage so the cost cap is enforced, and resumes the shepherd's session", async () => {
    const seen: Array<{ resume?: string; json?: boolean }> = [];
    const runner = createPlacedSessionRunner({
      invoke: async (_prompt, opts) => {
        seen.push({ resume: opts.resumeSessionId, json: opts.json });
        opts.onPlacement?.({ worker: "worker-b" });
        return JSON.stringify({ type: "result", result: "x", session_id: "s-1", total_cost_usd: 3, usage: { input_tokens: 10, output_tokens: 10 } });
      },
    });
    const shepherd = new TrainShepherd(runner);
    const r1 = await shepherd.runner({ worktree: "/w", prompt: "p", timeoutMs: 1000, turn: 1 });
    expect(r1).toMatchObject({ sessionId: "s-1", costUsd: 3, worker: "worker-b" });
    await shepherd.runner({ worktree: "/w", prompt: "p", timeoutMs: 1000, turn: 2 });
    expect(seen).toEqual([{ resume: undefined, json: true }, { resume: "s-1", json: true }]);
    expect(shepherd.toDto()).toMatchObject({ worker: "worker-b", turns: 2, costUsd: 6, tokens: 40 });

    // $3 of conflict turns already spent leaves < $5 for the fix: a $3 fix turn trips the shared cap
    const repoDir = mkdtempSync(join(tmpdir(), "ak-train-cap-"));
    try {
      git(repoDir, "init", "-q");
      git(repoDir, "config", "user.email", "t@t");
      git(repoDir, "config", "user.name", "t");
      writeFileSync(join(repoDir, "a"), "1");
      git(repoDir, "add", "-A");
      git(repoDir, "commit", "-qm", "init");
      const out = await runAgentFix({
        worktree: repoDir, label: "train/c", baseBranch: "main", members: [], initialFailure: { message: "red" }, caps,
        runAgent: runner, regate: async () => ({ passed: false, message: "red" }), priorCostUsd: 3, writeBrief: async () => undefined,
      });
      expect(out.attempt.verdict).toBe("agent_fix_capped");
      expect(out.attempt.agentFix).toMatchObject({ capped: "cost", costUsd: 3 });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("starts a fresh session when the resumed one is not on this machine", async () => {
    const prompts: string[] = [];
    const runner = createPlacedSessionRunner({
      invoke: async (prompt, opts) => {
        prompts.push(prompt);
        if (opts.resumeSessionId) throw new Error("No conversation found with session ID: s-1");
        return JSON.stringify({ type: "result", result: "x", session_id: "s-2", usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    const r = await runner({ worktree: "/w", prompt: "go", timeoutMs: 1000, turn: 2, resumeSessionId: "s-1" });
    expect(r.sessionId).toBe("s-2");
    expect(prompts[1]).toContain("earlier session is not available");
  });
});

describe("held train and the attention line (#1572)", () => {
  const mem = (n: number, files: string[]): TrainMember => ({ workspaceId: `w${n}`, branch: `feature/${n}`, issueNumber: n, changedFiles: files });
  const red = (over: Partial<TrainRunResult> = {}): TrainRunResult => ({
    trainRef: "kanban/train/train/x", landed: [], dropped: [], gateRejected: [], sided: [], gateRuns: 1, closeFailures: [], attempts: [],
    gateFailure: "red", failedSuites: ["packages/a/z.test.ts"], redStrategy: "agent-fix", ...over,
  });

  it("emits one attention line when no member owns the failing files, and messages nobody", () => {
    const members = [mem(1, ["a.ts"]), mem(2, ["b.ts"])];
    expect(decideTrainRedFeedbackTargets(red(), members)).toEqual([]);
    const line = describeUnownedTrainRed("train/x", red(), members);
    expect(line).toContain("ATTENTION train/x");
    expect(line).toContain("no builder was messaged");
  });

  it("says nothing when a member owns the red, and nothing for a held (inconclusive) train", () => {
    const members = [mem(1, ["packages/a/z.test.ts"])];
    expect(describeUnownedTrainRed("train/x", red(), members)).toBeNull();
    expect(describeUnownedTrainRed("train/x", red({ inconclusive: true }), [mem(2, ["b.ts"])])).toBeNull();
    expect(decideTrainRedFeedbackTargets(red({ inconclusive: true }), members)).toEqual([]);
  });

  it("formats the shepherd line for the train row", () => {
    expect(formatShepherdLine({ shepherd: { sessionId: "1234567890", worker: "worker-a", turns: 3, lastAction: "fixing gate" } }))
      .toBe("shepherd 12345678 on worker-a · 3 turns · fixing gate");
    expect(formatShepherdLine({})).toBeNull();
  });
});
