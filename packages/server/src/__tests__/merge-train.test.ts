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

describe("merge train assembly", () => {
  it("assembles non-conflicting members and keeps every tip an ancestor of the train", async () => {
    await git(["branch", "f1"]);
    await git(["branch", "f2"]);
    await commitFile("f1", "a.txt", "a\n");
    await commitFile("f2", "b.txt", "b\n");
    await git(["checkout", "-q", "main"]);

    const result = await assembleMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }, { workspaceId: "w2", branch: "f2" }],
      label: "t1",
    });

    expect(result.included.map((m) => m.branch)).toEqual(["f1", "f2"]);
    expect(result.dropped).toEqual([]);
    expect(result.trainSha).toBeTruthy();
    // The invariant the rest of the merge subsystem depends on.
    await expect(assertTrainPreservesAncestry(repo, result.trainRef, result.included)).resolves.toBeUndefined();
  });

  it("DROPS a conflicting member instead of failing the whole batch", async () => {
    // One bad member must not deny the rest of the wave the amortized gate.
    await git(["branch", "f1"]);
    await git(["branch", "f2"]);
    await commitFile("f1", "shared.txt", "from f1\n");
    await commitFile("f2", "shared.txt", "from f2\n");
    await git(["checkout", "-q", "main"]);

    const result = await assembleMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }, { workspaceId: "w2", branch: "f2", issueNumber: 42 }],
      label: "t2",
    });

    expect(result.included.map((m) => m.branch)).toEqual(["f1"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].member.branch).toBe("f2");
    // #1191: a member-vs-member conflict names the member it collides WITH and is deferred to
    // the next train (its branch is clean against the base), not sent to the rebase path.
    expect(result.dropped[0].reason).toContain("conflicts with f1");
    expect(result.dropped[0].deferred).toBe(true);
    expect(result.conflictClusters.map((c) => [...c.workspaceIds].sort())).toEqual([["w1", "w2"]]);
    // The dropped member's branch is untouched, so the per-ticket path can still land it.
    await expect(revParse(repo, "f2")).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("#1191: stacks in least-overlap order, so a member is no longer dropped for its PLACE in the list", async () => {
    // Plan order is [clash, a, b]: `clash` collides with both a and b, which are clean with each
    // other. In plan order clash would ride alone and a + b would both be dropped; the graph
    // keeps the larger conflict-free set {a, b} and defers clash, naming a kept member.
    for (const b of ["clash", "a", "b"]) await git(["branch", b]);
    await commitFile("clash", "x.txt", "clash x\n");
    await commitFile("clash", "y.txt", "clash y\n");
    await commitFile("a", "x.txt", "a x\n");
    await commitFile("b", "y.txt", "b y\n");
    await git(["checkout", "-q", "main"]);

    const result = await assembleMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [
        { workspaceId: "w-clash", branch: "clash", issueNumber: 9 },
        { workspaceId: "w-a", branch: "a", issueNumber: 1 },
        { workspaceId: "w-b", branch: "b", issueNumber: 2 },
      ],
      label: "t-overlap",
    });

    expect(result.included.map((m) => m.branch)).toEqual(["a", "b"]);
    expect(result.dropped.map((d) => d.member.branch)).toEqual(["clash"]);
    expect(result.dropped[0].reason).toMatch(/conflicts with (a \(#1\)|b \(#2\))/);
    expect(result.dropped[0].deferred).toBe(true);
    // No member branch was rebased: every included tip is still an ancestor of the train.
    await expect(assertTrainPreservesAncestry(repo, result.trainRef, result.included)).resolves.toBeUndefined();
    // One cluster: everyone who collided with anyone, for the group-scan to read back.
    expect(result.conflictClusters.map((c) => [...c.workspaceIds].sort())).toEqual([["w-a", "w-b", "w-clash"]]);
  });

  it("#1191: a base-only conflict is still dropped by assembly, and is NOT deferred", async () => {
    // f-stale edits shared.txt, and main moves on shared.txt after the branch: no sibling
    // collides with it, so the graph keeps it, and the merge onto the train ref is what fails.
    await git(["branch", "f-stale"]);
    await git(["branch", "f-clean"]);
    await commitFile("f-stale", "shared.txt", "from branch\n");
    await commitFile("f-clean", "other.txt", "clean\n");
    await commitFile("main", "shared.txt", "from main\n");

    const result = await assembleMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w-stale", branch: "f-stale" }, { workspaceId: "w-clean", branch: "f-clean" }],
      label: "t-base",
    });

    expect(result.included.map((m) => m.branch)).toEqual(["f-clean"]);
    expect(result.dropped.map((d) => d.member.branch)).toEqual(["f-stale"]);
    expect(result.dropped[0].deferred).toBeUndefined();
    expect(result.conflictClusters).toEqual([]);
  });

  it("lands the train so that EVERY member becomes an ancestor of the base (one gate, N tickets)", async () => {
    await git(["branch", "f1"]);
    await git(["branch", "f2"]);
    await git(["branch", "f3"]);
    await commitFile("f1", "a.txt", "a\n");
    await commitFile("f2", "b.txt", "b\n");
    await commitFile("f3", "c.txt", "c\n");
    await git(["checkout", "-q", "main"]);

    const asm = await assembleMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [
        { workspaceId: "w1", branch: "f1" },
        { workspaceId: "w2", branch: "f2" },
        { workspaceId: "w3", branch: "f3" },
      ],
      label: "t3",
    });
    expect(asm.included).toHaveLength(3);

    const { mergeSha } = await landMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      trainRef: asm.trainRef,
      trainSha: asm.trainSha!,
      baseSha: asm.baseSha,
      included: asm.included,
    });
    expect(mergeSha).toMatch(/^[0-9a-f]{40}$/);

    for (const branch of ["f1", "f2", "f3"]) {
      const tip = await revParse(repo, branch);
      // This is precisely what checkAlreadyMerged / the done-unmerged scanner check.
      expect(await isAncestor(repo, tip, "main")).toBe(true);
    }
  });

  it("REFUSES to land when the base moved after gating (that tree was never verified)", async () => {
    await git(["branch", "f1"]);
    await commitFile("f1", "a.txt", "a\n");
    await git(["checkout", "-q", "main"]);
    const asm = await assembleMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }],
      label: "t4",
    });

    // Someone else lands on main between gating and landing.
    await commitFile("main", "intruder.txt", "x\n");

    await expect(
      landMergeTrain({
        repoPath: repo,
        baseBranch: "main",
        trainRef: asm.trainRef,
        trainSha: asm.trainSha!,
        baseSha: asm.baseSha,
        included: asm.included,
      }),
    ).rejects.toThrow(/base 'main' moved/);
  });

  it("refuses to land an empty train", async () => {
    await expect(
      landMergeTrain({
        repoPath: repo,
        baseBranch: "main",
        trainRef: trainRefName("empty"),
        trainSha: "0".repeat(40),
        baseSha: "0".repeat(40),
        included: [],
      }),
    ).rejects.toThrow(/empty train/);
  });

  it("detects a squashed member — the mistake that makes the scanner duplicate landed work", async () => {
    await git(["branch", "f1"]);
    await commitFile("f1", "a.txt", "a\n");
    await git(["checkout", "-q", "main"]);

    // Build a train by SQUASHING instead of --no-ff, i.e. the forbidden shape.
    const trainRef = trainRefName("squashed");
    await git(["branch", "-f", trainRef, "main"]);
    await git(["checkout", "-q", trainRef]);
    await git(["merge", "--squash", "f1"]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "squashed f1"]);
    await git(["checkout", "-q", "main"]);

    await expect(
      assertTrainPreservesAncestry(repo, trainRef, [{ workspaceId: "w1", branch: "f1" }]),
    ).rejects.toThrow(/ancestry invariant violated/);
  });

  /**
   * #1215 — the finding's exact shape: a bisect leaf is checked against the ORIGINAL train's
   * roster (`included` naming a branch that was actually DROPPED from this leaf earlier for a
   * conflict), so the check compares against a member the leaf never carries. That branch then
   * lands on the base by another door entirely (a #797 foundational-blocker synchronous merge)
   * while the leaf gates — reachable from `baseBranch`, unreachable from the leaf's `trainRef`.
   * `checkAlreadyMerged`'s definition of "already merged" is exactly this: passing `baseBranch`
   * must resolve it instead of throwing "ancestry invariant violated".
   */
  it("accepts a member reachable from baseBranch even when it is unreachable from the leaf's train ref (#1215)", async () => {
    await git(["branch", "f-dropped"]);
    await git(["branch", "f-leaf"]);
    await commitFile("f-dropped", "d.txt", "dropped\n");
    await commitFile("f-leaf", "l.txt", "leaf\n");
    await git(["checkout", "-q", "main"]);

    // The LEAF only ever carries f-leaf — f-dropped was never assembled onto it (it left the
    // train earlier, exactly like #1186 leaving qmuaj7n7p's roster before leaf `bb` gated).
    const leaf = await assembleMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w-leaf", branch: "f-leaf" }],
      label: "t-leaf",
    });
    expect(leaf.included.map((m) => m.branch)).toEqual(["f-leaf"]);

    // f-dropped lands on main through another door while the leaf's gate is (conceptually)
    // still running — a synchronous merge, unrelated to this leaf's own --no-ff chain.
    await git(["merge", "--no-ff", "-q", "-m", "synchronous merge of f-dropped", "f-dropped"]);

    // Naively re-checking the leaf against the ORIGINAL roster (leaf.included plus the member
    // that actually left it) is the bug: f-dropped is genuinely unreachable from the leaf ref.
    const originalRoster = [...leaf.included, { workspaceId: "w-dropped", branch: "f-dropped" }];
    await expect(
      assertTrainPreservesAncestry(repo, leaf.trainRef, originalRoster),
    ).rejects.toThrow(/ancestry invariant violated/);

    // With baseBranch given, the same call recognizes f-dropped as already merged into main by
    // another door and does not throw.
    await expect(
      assertTrainPreservesAncestry(repo, leaf.trainRef, originalRoster, "main"),
    ).resolves.toBeUndefined();

    // The leaf's OWN included set (what it actually carries) was never the problem either way.
    await expect(
      assertTrainPreservesAncestry(repo, leaf.trainRef, leaf.included, "main"),
    ).resolves.toBeUndefined();
  });

  /**
   * `deleteTrainRef` used to be called at each of `runMergeTrain`'s three exits
   * (assembly-empty, gate-fail, success) — so a THROW from `assertTrainPreservesAncestry` or
   * `landMergeTrain` (base moved, ancestry violation) skipped all of them and left the
   * `refs/kanban/train/q…` branch behind. Failed trains are exactly the case that recurs, so
   * the refs accumulated in the repo for the life of the checkout. Cleanup belongs in a
   * `finally`.
   */
  it("deletes the train ref even when landing THROWS (base moved under the gate)", async () => {
    await git(["branch", "f1"]);
    await commitFile("f1", "a.txt", "a\n");
    await git(["checkout", "-q", "main"]);

    let trainRefDuringGate = "";
    await expect(
      runMergeTrain({
        repoPath: repo,
        baseBranch: "main",
        members: [{ workspaceId: "w1", branch: "f1" }],
        label: "t-throw",
        runGate: async ({ trainRef }) => {
          trainRefDuringGate = trainRef;
          // Another merge lands on main while the (long) gate runs — landMergeTrain must refuse,
          // and that refusal is a throw, not a returned gateFailure.
          await commitFile("main", "intruder.txt", "x\n");
          return { passed: true, message: "ok" };
        },
        closeMember: async () => {},
      }),
    ).rejects.toThrow(/base 'main' moved/);

    expect(trainRefDuringGate).toBeTruthy();
    await expect(revParse(repo, trainRefDuringGate)).rejects.toBeTruthy();
  });
}, 240000);

describe("train label formatting (#1190)", () => {
  it("formats a date-stamped, zero-padded per-day sequence label", () => {
    expect(formatTrainLabel("2026-09-17", 3)).toBe("train/2026-09-17-03");
    expect(formatTrainLabel("2026-09-17", 1)).toBe("train/2026-09-17-01");
    expect(formatTrainLabel("2026-09-17", 42)).toBe("train/2026-09-17-42");
  });

  it("derives the parent label by stripping trailing bisect letters", () => {
    expect(parentTrainLabel("train/2026-09-17-03")).toBe("train/2026-09-17-03");
    expect(parentTrainLabel("train/2026-09-17-03a")).toBe("train/2026-09-17-03");
    expect(parentTrainLabel("train/2026-09-17-03ab")).toBe("train/2026-09-17-03");
  });
});

describe("buildMergeTrainCommitMessage / parseMergeTrainTrailer (#1190)", () => {
  it("composes a subject naming the label and member issues, plus a matchable trailer", () => {
    const message = buildMergeTrainCommitMessage({
      parentLabel: "train/2026-09-17-03",
      included: [
        { workspaceId: "w1", branch: "feature/ak-1176-x", issueNumber: 1176, tipSha: "a".repeat(40) },
        { workspaceId: "w2", branch: "feature/ak-1177-y", issueNumber: 1177, tipSha: "b".repeat(40) },
      ],
      evidence: { trainId: "row-1", trainSha: "c".repeat(40), baseSha: "d".repeat(40), gateRuns: 1, gateMessage: "ok" },
    });
    expect(message.split("\n")[0]).toBe("Merge train 2026-09-17-03: #1176 #1177");
    expect(parseMergeTrainTrailer(message)).toBe("row-1");
  });

  it("omits the issue-number suffix when no member carries one", () => {
    const message = buildMergeTrainCommitMessage({
      parentLabel: "train/2026-09-17-01",
      included: [{ workspaceId: "w1", branch: "direct-work", tipSha: "a".repeat(40) }],
      evidence: { trainId: "row-2", trainSha: "c".repeat(40), baseSha: "d".repeat(40), gateRuns: 1, gateMessage: "ok" },
    });
    expect(message.split("\n")[0]).toBe("Merge train 2026-09-17-01");
  });

  it("returns null when no trailer is present", () => {
    expect(parseMergeTrainTrailer("Merge branch 'kanban/train/qmu4t981aba'")).toBeNull();
  });
});
