import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import {
  assembleMergeTrain,
  assertTrainPreservesAncestry,
  landMergeTrain,
  deleteTrainRef,
  runMergeTrain,
  trainRefName,
  formatTrainLabel,
  parentTrainLabel,
  buildMergeTrainCommitMessage,
  parseMergeTrainTrailer,
} from "../services/merge-train.service.js";
import { commitFile, git, repo, setupTrainRepo } from "./helpers/merge-train-repo.js";

/**
 * Real git, because every claim the train makes is about ANCESTRY — the property the whole
 * merge subsystem keys off (`checkBranchTipIsAncestor`, `checkAlreadyMerged`, the
 * done-unmerged invariant scanner). Mocking git here would test nothing that matters.
 * Split across three files (#1511) so the workers run them in parallel; the fixture is in
 * `helpers/merge-train-repo.ts`.
 */
setupTrainRepo();

/**
 * #1185 — a member whose ONLY problem is a conflict must stay under `dropped`. The module
 * docstring is explicit: a conflict is the author's to REBASE, a gate failure the author's to
 * FIX, and reporting one as the other sends them to the wrong place. `landGreenest` used to
 * promote every red singleton to `gateRejected`, including one whose "gate failure" was
 * "no members could be assembled onto the train" — no gate ever ran on it.
 */
describe("runMergeTrain — a conflict-only member is dropped, never gate-rejected (#1185)", () => {
  /** `f-conflict` edits a file that main ALSO changes after branching, so it conflicts with the base itself. */
  async function seedBaseConflict() {
    await git(["branch", "f-conflict"]);
    await commitFile("f-conflict", "shared.txt", "from branch\n");
    await commitFile("main", "shared.txt", "from main\n");
  }

  it("a singleton batch that cannot be assembled is reported as dropped, with its conflict reason", async () => {
    await seedBaseConflict();
    const runGate = vi.fn().mockResolvedValue({ passed: true, message: "ok" });

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w-conflict", branch: "f-conflict", issueNumber: 7 }],
      label: "t-1185-single",
      runGate,
      closeMember: async () => {},
    });

    expect(runGate).not.toHaveBeenCalled();
    expect(result.landed).toEqual([]);
    expect(result.gateRejected).toEqual([]);
    expect(result.dropped.map((d) => d.member.workspaceId)).toEqual(["w-conflict"]);
    expect(result.dropped[0].reason).not.toContain("no members could be assembled");
    expect(result.gateFailure).toContain("no members could be assembled");
  });

  it("a bisect that isolates a base-conflicting member keeps it under dropped and blames only the red one", async () => {
    await seedBaseConflict();
    await git(["branch", "f-red"]);
    await commitFile("f-red", "red.txt", "red\n");
    await git(["checkout", "-q", "main"]);
    // Red whenever f-red's file is in the assembled tree — so the top-level attempt (f-red
    // assembled, f-conflict dropped) is red and the driver splits into two singletons.
    const runGate = vi.fn(async ({ trainRef }: { trainRef: string }) => {
      const tree = await gitExecOrThrow(["ls-tree", "-r", "--name-only", trainRef], { cwd: repo });
      return tree.split(/\r?\n/).includes("red.txt")
        ? { passed: false, message: "verify failed: red.txt is red" }
        : { passed: true, message: "ok" };
    });

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [
        { workspaceId: "w-red", branch: "f-red", issueNumber: 8 },
        { workspaceId: "w-conflict", branch: "f-conflict", issueNumber: 7 },
      ],
      label: "t-1185-bisect",
      runGate,
      closeMember: async () => {},
    });

    expect(result.landed).toEqual([]);
    // Exactly one culprit, and it is the branch the gate is red on.
    expect(result.gateRejected.map((r) => r.member.workspaceId)).toEqual(["w-red"]);
    expect(result.gateRejected[0].reason).toContain("red.txt is red");
    // The conflicting member appears ONLY under dropped, every time with its conflict reason.
    const droppedIds = new Set(result.dropped.map((d) => d.member.workspaceId));
    expect([...droppedIds]).toEqual(["w-conflict"]);
    for (const d of result.dropped) expect(d.reason).not.toContain("no members could be assembled");
    // Top-level attempt + the red singleton; the conflict-only singleton never reached a gate.
    expect(result.gateRuns).toBe(2);
  });
}, 240000);

describe("runMergeTrain — a member sided by the train review is withheld, the rest land (#1194)", () => {
  async function seedTwoGreen() {
    await git(["branch", "f1"]);
    await git(["branch", "f2"]);
    await commitFile("f1", "a.txt", "a\n");
    await commitFile("f2", "b.txt", "b\n");
    await git(["checkout", "-q", "main"]);
  }

  it("gate once, review once: w2 sided → w1 lands, w2's branch is untouched and NOT on main", async () => {
    await seedTwoGreen();
    const w2TipBefore = await revParse(repo, "f2");
    const closed: string[] = [];
    const runGate = vi.fn().mockResolvedValue({
      passed: true, message: "ok",
      sided: [{ workspaceId: "w2", reason: "train review (#1194): CRITICAL b.txt: unchecked null" }],
    });

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1", issueNumber: 1 }, { workspaceId: "w2", branch: "f2", issueNumber: 2 }],
      label: "t-1194",
      runGate,
      closeMember: async (id) => { closed.push(id); },
    });

    // ONE gate run (and so one review) for the whole train — no re-gate of the sided-off tree.
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.gateRuns).toBe(1);
    expect(result.landed.map((m) => m.workspaceId)).toEqual(["w1"]);
    expect(result.sided.map((s) => [s.member.workspaceId, s.reason])).toEqual([["w2", "train review (#1194): CRITICAL b.txt: unchecked null"]]);
    expect(result.gateRejected).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(closed).toEqual(["w1"]);

    // The ancestry facts the rest of the merge subsystem keys off.
    expect(await isAncestor(repo, await revParse(repo, "f1"), "main")).toBe(true);
    expect(await isAncestor(repo, w2TipBefore, "main")).toBe(false);
    expect(await revParse(repo, "f2")).toBe(w2TipBefore);
    // The train ref and its re-assembled sibling are both gone.
    await expect(revParse(repo, trainRefName("t-1194"))).rejects.toThrow();
    await expect(revParse(repo, trainRefName("t-1194-sided"))).rejects.toThrow();

    // The attempt record carries the siding, and the verdict is still `landed` (w1 did).
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ verdict: "landed", gateRuns: 1, sided: [{ workspaceId: "w2" }] });
    expect(result.attempts[0].mergeSha).toBe(result.mergeSha);
  });

  it("every member sided → verdict `sided`, nothing lands, nothing is blamed on the batch", async () => {
    await seedTwoGreen();
    const mainBefore = await revParse(repo, "main");
    const runGate = vi.fn().mockResolvedValue({
      passed: true, message: "ok",
      sided: [{ workspaceId: "w1", reason: "r1" }, { workspaceId: "w2", reason: "r2" }],
    });

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }, { workspaceId: "w2", branch: "f2" }],
      label: "t-1194-all",
      runGate,
      closeMember: async () => { throw new Error("must not close anyone"); },
    });

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.landed).toEqual([]);
    expect(result.gateRejected).toEqual([]);
    expect(result.sided.map((s) => s.member.workspaceId)).toEqual(["w1", "w2"]);
    expect(result.gateFailure).toContain("sided by the train review");
    expect(result.attempts[0].verdict).toBe("sided");
    expect(await revParse(repo, "main")).toBe(mainBefore);
    await expect(revParse(repo, trainRefName("t-1194-all"))).rejects.toThrow();
  });

  it("a sided member on a bisected sub-train: the red one is gate-rejected, the sided one withheld, the green one lands", async () => {
    await seedTwoGreen();
    await git(["branch", "f-red"]);
    await commitFile("f-red", "red.txt", "red\n");
    await git(["checkout", "-q", "main"]);
    const runGate = vi.fn(async ({ trainRef, included }: { trainRef: string; included: Array<{ workspaceId: string }> }) => {
      const tree = await gitExecOrThrow(["ls-tree", "-r", "--name-only", trainRef], { cwd: repo });
      if (tree.split(/\r?\n/).includes("red.txt")) return { passed: false, message: "verify failed: red.txt is red" };
      // A green sub-train gets its own review; it sides w2 whenever w2 is aboard.
      return included.some((m) => m.workspaceId === "w2")
        ? { passed: true, message: "ok", sided: [{ workspaceId: "w2", reason: "train review (#1194): MAJOR b.txt: x" }] }
        : { passed: true, message: "ok" };
    });

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [
        { workspaceId: "w1", branch: "f1" },
        { workspaceId: "w2", branch: "f2" },
        { workspaceId: "w-red", branch: "f-red" },
      ],
      label: "t-1194-bisect",
      runGate,
      closeMember: async () => {},
    });

    expect(result.landed.map((m) => m.workspaceId)).toEqual(["w1"]);
    expect(result.gateRejected.map((r) => r.member.workspaceId)).toEqual(["w-red"]);
    expect(result.sided.map((s) => s.member.workspaceId)).toEqual(["w2"]);
    expect(await isAncestor(repo, await revParse(repo, "f1"), "main")).toBe(true);
    expect(await isAncestor(repo, await revParse(repo, "f2"), "main")).toBe(false);
    expect(await isAncestor(repo, await revParse(repo, "f-red"), "main")).toBe(false);
  });

  it("a red naming only one member's own suite rejects it and re-gates the rest once: no control arm, no halving", async () => {
    await seedTwoGreen();
    await git(["branch", "f-red"]);
    await commitFile("f-red", "red.test.ts", "red\n");
    await git(["checkout", "-q", "main"]);
    const runGate = vi.fn(async ({ trainRef }: { trainRef: string }) => {
      const tree = await gitExecOrThrow(["ls-tree", "-r", "--name-only", trainRef], { cwd: repo });
      return tree.split(/\r?\n/).includes("red.test.ts")
        ? { passed: false, message: "verify failed", failedSuites: ["red.test.ts"] }
        : { passed: true, message: "ok" };
    });
    const gateBaseAlone = vi.fn(async () => ({ verdict: "green" as const, gateRuns: 1 }));

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [
        { workspaceId: "w1", branch: "f1", changedFiles: ["a.txt"] },
        { workspaceId: "w-red", branch: "f-red", changedFiles: ["red.test.ts"] },
        { workspaceId: "w2", branch: "f2", changedFiles: ["b.txt"] },
      ],
      label: "t-suite-owner",
      runGate,
      gateBaseAlone,
      closeMember: async () => {},
    });

    expect(runGate).toHaveBeenCalledTimes(2);
    expect(result.gateRuns).toBe(2);
    expect(gateBaseAlone).not.toHaveBeenCalled();
    expect(result.landed.map((x) => x.workspaceId).sort()).toEqual(["w1", "w2"]);
    expect(result.gateRejected.map((r) => r.member.workspaceId)).toEqual(["w-red"]);
    expect(result.gateRejected[0].reason).toContain("red.test.ts");
    expect(result.gateFailure).toBeUndefined();
    expect(await isAncestor(repo, await revParse(repo, "f-red"), "main")).toBe(false);
  });
}, 240000);
