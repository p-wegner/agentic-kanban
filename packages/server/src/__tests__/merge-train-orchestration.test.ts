import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { runMergeTrain } from "../services/merge-train.service.js";

/**
 * Orchestration-level behaviour of a release train, with the two expensive collaborators
 * injected: the gate (40 minutes in production) and the member close-out (`reconcileAlreadyMerged`,
 * which needs a DB). Real git underneath, because the ancestry claims are the whole point.
 */
let repo: string;

// gitExecOrThrow takes an OPTIONS OBJECT — a bare cwd string leaves cwd undefined and the
// command runs in the process cwd against the wrong repo.
const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });

async function commitOn(branch: string, file: string, content: string) {
  await git(["checkout", "-q", branch]);
  writeFileSync(join(repo, file), content, "utf8");
  await git(["add", file]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-orch-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
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

describe("runMergeTrain", () => {
  it("gates ONCE for the whole batch and lands every member", async () => {
    const runGate = vi.fn().mockResolvedValue({ passed: true, message: "ok" });
    const closeMember = vi.fn().mockResolvedValue(undefined);

    const result = await runMergeTrain({ repoPath: repo, baseBranch: "main", members, label: "b1", runGate, closeMember });

    // The entire economic argument for trains: one gate, N tickets.
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.landed).toHaveLength(2);
    expect(result.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(closeMember.mock.calls.map((c) => c[0])).toEqual(["w1", "w2"]);

    for (const branch of ["f1", "f2"]) {
      expect(await isAncestor(repo, await revParse(repo, branch), "main")).toBe(true);
    }
  }, 240000);

  it("lands NOTHING when the train gate fails, leaving members mergeable by the per-ticket path", async () => {
    const before = await revParse(repo, "main");
    const runGate = vi.fn().mockResolvedValue({ passed: false, message: "verify failed: 3 tests red" });
    const closeMember = vi.fn();

    const result = await runMergeTrain({ repoPath: repo, baseBranch: "main", members, label: "b2", runGate, closeMember });

    expect(result.landed).toEqual([]);
    expect(result.gateFailure).toContain("verify failed");
    expect(closeMember).not.toHaveBeenCalled();
    // Base untouched, so a red train costs time but never corrupts state.
    expect(await revParse(repo, "main")).toBe(before);
    for (const branch of ["f1", "f2"]) {
      expect(await isAncestor(repo, await revParse(repo, branch), "main")).toBe(false);
    }
  }, 240000);

  it("still lands the clean members when one conflicts, and reports the dropped one", async () => {
    // f3 conflicts with f1 on the same file.
    await git(["branch", "f3", "main"]);
    await commitOn("f1", "clash.txt", "from f1\n");
    await commitOn("f3", "clash.txt", "from f3\n");
    await git(["checkout", "-q", "main"]);

    const runGate = vi.fn().mockResolvedValue({ passed: true, message: "ok" });
    const closeMember = vi.fn().mockResolvedValue(undefined);
    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [...members, { workspaceId: "w3", branch: "f3", issueNumber: 3 }],
      label: "b3",
      runGate,
      closeMember,
    });

    expect(result.dropped.map((d) => d.member.branch)).toEqual(["f3"]);
    expect(result.landed.map((m) => m.branch)).toEqual(["f1", "f2"]);
    // The dropped member is untouched and still unmerged — the per-ticket path can handle it.
    expect(await isAncestor(repo, await revParse(repo, "f3"), "main")).toBe(false);
  }, 240000);

  it("reports a close-out failure WITHOUT claiming the merge failed (the work did land)", async () => {
    const runGate = vi.fn().mockResolvedValue({ passed: true, message: "ok" });
    const closeMember = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("DB write failed"));

    const result = await runMergeTrain({ repoPath: repo, baseBranch: "main", members, label: "b4", runGate, closeMember });

    expect(result.landed).toHaveLength(2);
    expect(result.mergeSha).toBeTruthy();
    expect(result.closeFailures).toHaveLength(1);
    expect(result.closeFailures[0].member.workspaceId).toBe("w2");
    // Bookkeeping lagging is NOT the same as the merge failing — w2's work is on main.
    expect(await isAncestor(repo, await revParse(repo, "f2"), "main")).toBe(true);
  }, 240000);

  it("does not gate at all when nothing could be assembled", async () => {
    const runGate = vi.fn();
    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "wx", branch: "does-not-exist" }],
      label: "b5",
      runGate,
      closeMember: vi.fn(),
    });
    expect(runGate).not.toHaveBeenCalled();
    expect(result.landed).toEqual([]);
    expect(result.gateFailure).toMatch(/no members/);
  }, 240000);
});

/**
 * #492 — one bad branch must not block the rest of the queue.
 *
 * Before this, a red train landed NOTHING: five ready branches, one of them broken, cost a
 * full gate run and left all five unmerged, and the only recovery was to fall back to five
 * per-ticket gates. Bisecting the batch keeps the good branches moving and — the part that
 * matters for the author — says WHICH branch was red instead of blaming the batch.
 */
describe("runMergeTrain — bisect a red batch (#492)", () => {
  /** A gate that fails only when the train contains the named branch's file. */
  function gateFailingFor(badFile: string) {
    return vi.fn(async ({ trainRef }: { trainRef: string }) => {
      // gitExecOrThrow resolves with stdout as a STRING, not `{ stdout }`.
      const tree = await gitExecOrThrow(["ls-tree", "-r", "--name-only", trainRef], { cwd: repo });
      return tree.split(/\r?\n/).includes(badFile)
        ? { passed: false, message: `verify failed: ${badFile} is red` }
        : { passed: true, message: "ok" };
    });
  }

  it("lands the good branch and attributes the failure to the bad one", async () => {
    // f1 -> a.txt (good), f2 -> b.txt (bad).
    const runGate = gateFailingFor("b.txt");
    const closeMember = vi.fn().mockResolvedValue(undefined);

    const result = await runMergeTrain({ repoPath: repo, baseBranch: "main", members, label: "bs1", runGate, closeMember });

    expect(result.landed.map((m) => m.branch)).toEqual(["f1"]);
    expect(result.gateRejected.map((r) => r.member.branch)).toEqual(["f2"]);
    expect(result.gateRejected[0].reason).toContain("b.txt is red");
    // The good branch really is on the base; the bad one really is not.
    expect(await isAncestor(repo, await revParse(repo, "f1"), "main")).toBe(true);
    expect(await isAncestor(repo, await revParse(repo, "f2"), "main")).toBe(false);
    // A gate-rejected member is not a DROPPED member — dropped means "could not assemble".
    expect(result.dropped).toEqual([]);
  }, 240000);

  it("costs ONE gate run when the batch is green — bisect never fires on the happy path", async () => {
    const runGate = vi.fn().mockResolvedValue({ passed: true, message: "ok" });
    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "bs2", runGate, closeMember: vi.fn().mockResolvedValue(undefined),
    });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.gateRuns).toBe(1);
    expect(result.landed).toHaveLength(2);
  }, 240000);

  it("reports the gate runs it actually spent, so the batching claim is falsifiable", async () => {
    const runGate = gateFailingFor("b.txt");
    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "bs3", runGate, closeMember: vi.fn().mockResolvedValue(undefined),
    });
    // Full batch (red) + each half individually = 3, and the count says so rather than the
    // caller assuming the advertised 1.
    expect(result.gateRuns).toBe(runGate.mock.calls.length);
    expect(result.gateRuns).toBeGreaterThan(1);
  }, 240000);

  it("still lands NOTHING, and blames nobody individually, when bisect is off", async () => {
    // The old all-or-nothing behaviour, kept reachable so the change is a choice, not a fait
    // accompli.
    const runGate = gateFailingFor("b.txt");
    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "bs4", runGate,
      closeMember: vi.fn().mockResolvedValue(undefined), bisectOnFailure: false,
    });
    expect(result.landed).toEqual([]);
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.gateFailure).toContain("b.txt is red");
  }, 240000);

  it("attributes EVERY branch when they are all red, rather than one arbitrary scapegoat", async () => {
    const runGate = vi.fn().mockResolvedValue({ passed: false, message: "everything is red" });
    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "bs5", runGate, closeMember: vi.fn(),
    });
    expect(result.landed).toEqual([]);
    expect(result.gateRejected.map((r) => r.member.branch).sort()).toEqual(["f1", "f2"]);
    expect(result.gateFailure).toBeTruthy();
  }, 240000);
});

/**
 * #1154 — an environment failure (a broken staging worktree, e.g. missing dependencies) fails
 * identically for the whole batch and for every half a bisect would try, so bisecting it can
 * only burn gate runs and mislabel an innocent branch as individually red. `isEnvironmentFailure`
 * lets the caller say "this verdict is not about the code" and short-circuits the split.
 */
describe("runMergeTrain — environment failures skip bisect (#1154)", () => {
  it("does not bisect, costs exactly one gate run, and blames nobody individually", async () => {
    const runGate = vi.fn().mockResolvedValue({
      passed: false,
      message: "Cannot find module '@playwright/test' or its corresponding type declarations",
    });
    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members,
      label: "env1",
      runGate,
      closeMember: vi.fn(),
      isEnvironmentFailure: (message) => /cannot find module/i.test(message),
    });

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(result.gateRuns).toBe(1);
    expect(result.landed).toEqual([]);
    // Attribution-free: neither member is individually blamed for a problem that was never in
    // their code.
    expect(result.gateRejected).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.gateFailure).toContain("Cannot find module");
  }, 240000);

  it("still bisects normally when no classifier is supplied (today's behaviour, unchanged)", async () => {
    const runGate = vi.fn().mockResolvedValue({
      passed: false,
      message: "Cannot find module '@playwright/test'",
    });
    const result = await runMergeTrain({
      repoPath: repo, baseBranch: "main", members, label: "env2", runGate, closeMember: vi.fn(),
    });
    // No classifier passed → bisects as before, spending more than one gate run.
    expect(result.gateRuns).toBeGreaterThan(1);
  }, 240000);
});

/**
 * #1193 — with two free verify slots, a bisect's two halves gate concurrently instead of one
 * after another, and still land in the original left-to-right order.
 */
describe("runMergeTrain — speculative bisect gates concurrently when slots allow (#1193)", () => {
  async function setUpFourMembers() {
    await git(["branch", "f3", "main"]);
    await git(["branch", "f4", "main"]);
    await commitOn("f3", "c.txt", "c\n");
    await commitOn("f4", "d.txt", "d\n");
    await git(["checkout", "-q", "main"]);
    return [
      { workspaceId: "w1", branch: "f1", issueNumber: 1 },
      { workspaceId: "w2", branch: "f2", issueNumber: 2 },
      { workspaceId: "w3", branch: "f3", issueNumber: 3 },
      { workspaceId: "w4", branch: "f4", issueNumber: 4 },
    ];
  }

  /** f1/f3 are good; f2/f4 are bad. Records how many gates were IN FLIGHT at once. */
  function trackingGate() {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runGate = vi.fn(async ({ trainRef }: { trainRef: string; label: string }) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const tree = await gitExecOrThrow(["ls-tree", "-r", "--name-only", trainRef], { cwd: repo });
      const files = tree.split(/\r?\n/);
      // Long enough that two concurrently-admitted gates are actually in flight together.
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent--;
      const bad = files.includes("b.txt") || files.includes("d.txt");
      return bad
        ? { passed: false, message: "verify failed: a bad branch is in this half" }
        : { passed: true, message: "ok" };
    });
    return { runGate, maxConcurrent: () => maxConcurrent };
  }

  it("gates two bisect halves in parallel when freeVerifySlots reports 2, and lands only the good branches", async () => {
    const allMembers = await setUpFourMembers();
    const { runGate, maxConcurrent } = trackingGate();

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: allMembers,
      label: "par1",
      runGate,
      closeMember: vi.fn().mockResolvedValue(undefined),
      freeVerifySlots: () => 2,
    });

    expect(maxConcurrent()).toBeGreaterThan(1);
    expect(result.landed.map((m) => m.branch).sort()).toEqual(["f1", "f3"]);
    expect(result.gateRejected.map((r) => r.member.branch).sort()).toEqual(["f2", "f4"]);
    // The bisect tree records the overlap: the two halves' gate windows intersect in time, and
    // each gate was keyed by its OWN label, so a caller can tell the runs apart.
    const half = (label: string) => result.attempts.find((a) => a.label === label)!;
    const [a, b] = [half("par1a"), half("par1b")];
    expect(Date.parse(a.gateStartedAt!)).toBeLessThan(Date.parse(b.gateFinishedAt!));
    expect(Date.parse(b.gateStartedAt!)).toBeLessThan(Date.parse(a.gateFinishedAt!));
    expect(runGate.mock.calls.map((c) => c[0].label).sort()).toEqual(["par1", "par1a", "par1aa", "par1ab", "par1b", "par1ba", "par1bb"]);
    for (const branch of ["f1", "f3"]) {
      expect(await isAncestor(repo, await revParse(repo, branch), "main")).toBe(true);
    }
    for (const branch of ["f2", "f4"]) {
      expect(await isAncestor(repo, await revParse(repo, branch), "main")).toBe(false);
    }
  }, 240000);

  it("falls back to sequential gating when only one verify slot is free (capacity gate)", async () => {
    const allMembers = await setUpFourMembers();
    const { runGate, maxConcurrent } = trackingGate();

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: allMembers,
      label: "par2",
      runGate,
      closeMember: vi.fn().mockResolvedValue(undefined),
      freeVerifySlots: () => 1,
    });

    expect(maxConcurrent()).toBe(1);
    expect(result.landed.map((m) => m.branch).sort()).toEqual(["f1", "f3"]);
    expect(result.gateRejected.map((r) => r.member.branch).sort()).toEqual(["f2", "f4"]);
  }, 240000);

  it("still refuses to land a half whose base moved under it, even when gated in parallel", async () => {
    // Both halves are green, so both want to land — the second must wait for the first's
    // landing rather than racing it onto the same base.
    await git(["branch", "f3", "main"]);
    await commitOn("f3", "c.txt", "c\n");
    await git(["checkout", "-q", "main"]);
    const allMembers = [
      { workspaceId: "w1", branch: "f1", issueNumber: 1 },
      { workspaceId: "w2", branch: "f2", issueNumber: 2 },
      { workspaceId: "w3", branch: "f3", issueNumber: 3 },
    ];
    // Force a split even though the whole batch would gate green, by failing the FULL-batch
    // gate once and passing every half after.
    const runGate = vi.fn(async ({ included }: { included: { branch: string }[] }) => {
      if (included.length === allMembers.length) return { passed: false, message: "verify failed: flaked on the full batch" };
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { passed: true, message: "ok" };
    });
    const closeMember = vi.fn().mockResolvedValue(undefined);

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: allMembers,
      label: "par3",
      runGate,
      closeMember,
      freeVerifySlots: () => 2,
    });

    // All three land, and no base-moved throw escaped runMergeTrain.
    expect(result.landed.map((m) => m.branch).sort()).toEqual(["f1", "f2", "f3"]);
    for (const branch of ["f1", "f2", "f3"]) {
      expect(await isAncestor(repo, await revParse(repo, branch), "main")).toBe(true);
    }
  }, 240000);
});
