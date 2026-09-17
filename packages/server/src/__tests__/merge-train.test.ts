import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
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
} from "../services/merge-train.service.js";

/**
 * Real git, because every claim the train makes is about ANCESTRY — the property the whole
 * merge subsystem keys off (`checkBranchTipIsAncestor`, `checkAlreadyMerged`, the
 * done-unmerged invariant scanner). Mocking git here would test nothing that matters.
 */
let repo: string;

// NOTE: gitExecOrThrow takes an OPTIONS OBJECT. Passing a bare cwd string leaves cwd
// undefined, so every git call silently runs in the process cwd (packages/server) — which
// once created a stray nested repo there. Always pass `{ cwd }`.
async function git(args: string[], cwd = repo) {
  return gitExecOrThrow(args, { cwd });
}

async function commitFile(branch: string, name: string, content: string) {
  await git(["checkout", "-q", branch]);
  writeFileSync(join(repo, name), content, "utf8");
  await git(["add", name]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${name} on ${branch}`]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-"));
  mkdirSync(repo, { recursive: true });
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

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

  it("deletes the train ref on the ordinary exits too (gate failure, success)", async () => {
    await git(["branch", "f1"]);
    await commitFile("f1", "a.txt", "a\n");
    await git(["checkout", "-q", "main"]);

    const red = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }],
      label: "t-red",
      runGate: async () => ({ passed: false, message: "verify_script failed (exit 1)" }),
      closeMember: async () => {},
    });
    expect(red.landed).toEqual([]);
    expect(red.gateFailure).toContain("verify_script failed");
    await expect(revParse(repo, red.trainRef)).rejects.toBeTruthy();

    const green = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }],
      label: "t-green",
      runGate: async () => ({ passed: true, message: "ok" }),
      closeMember: async () => {},
    });
    expect(green.landed.map((m) => m.branch)).toEqual(["f1"]);
    await expect(revParse(repo, green.trainRef)).rejects.toBeTruthy();
  });

  it("cleans up the train ref", async () => {
    await git(["branch", "f1"]);
    await commitFile("f1", "a.txt", "a\n");
    await git(["checkout", "-q", "main"]);
    const asm = await assembleMergeTrain({ repoPath: repo, baseBranch: "main", members: [{ workspaceId: "w1", branch: "f1" }], label: "t5" });
    await deleteTrainRef(repo, asm.trainRef);
    await expect(revParse(repo, asm.trainRef)).rejects.toBeTruthy();
  });
}, 240000);

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
}, 240000);
