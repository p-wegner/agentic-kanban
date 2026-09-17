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
  formatTrainLabel,
  parentTrainLabel,
  buildMergeTrainCommitMessage,
  parseMergeTrainTrailer,
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
    // The dropped member's branch is untouched, so the per-ticket path can still land it.
    await expect(revParse(repo, "f2")).resolves.toMatch(/^[0-9a-f]{40}$/);
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

  /**
   * #1190 — the landing merge commit is self-describing: subject names the PARENT train label
   * and every member's issue number, and the body carries the gate evidence plus a
   * `Merge-Train:` trailer a reconciler can match structurally.
   */
  it("lands a train with a self-describing subject, body and Merge-Train trailer", async () => {
    await git(["branch", "f1"]);
    await git(["branch", "f2"]);
    await commitFile("f1", "a.txt", "a\n");
    await commitFile("f2", "b.txt", "b\n");
    await git(["checkout", "-q", "main"]);

    const members = [
      { workspaceId: "w1", branch: "f1", issueNumber: 1176 },
      { workspaceId: "w2", branch: "f2", issueNumber: 1177 },
    ];
    const asm = await assembleMergeTrain({ repoPath: repo, baseBranch: "main", members, label: "train/2026-09-17-03" });
    expect(asm.included).toHaveLength(2);

    const { mergeSha } = await landMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      trainRef: asm.trainRef,
      trainSha: asm.trainSha!,
      baseSha: asm.baseSha,
      included: asm.included,
      label: "train/2026-09-17-03",
      evidence: { trainId: "row-abc", gateRuns: 1, gateMessage: "pre-merge gate passed (tier: file-scoped)" },
    });

    expect(mergeSha).toMatch(/^[0-9a-f]{40}$/);

    // `mergeBranch`'s return value is a status STRING, not the commit message — the composed
    // message is what actually lands as the commit's subject+body, so assert on git itself.
    const actualSubject = (await gitExecOrThrow(["log", "-1", "--format=%s", "main"], { cwd: repo })).trim();
    expect(actualSubject).toBe("Merge train 2026-09-17-03: #1176 #1177");
    const actualBody = (await gitExecOrThrow(["log", "-1", "--format=%B", "main"], { cwd: repo })).trim();
    expect(actualBody).toContain("- #1176 f1 @");
    expect(actualBody).toContain("- #1177 f2 @");
    expect(actualBody).toContain("Gate: 1 run(s) — pre-merge gate passed (tier: file-scoped)");
    expect(actualBody).toContain(`Train sha: ${asm.trainSha}`);
    expect(actualBody).toContain(`Base sha: ${asm.baseSha}`);
    expect(actualBody).not.toContain("Attempt:");
    expect(parseMergeTrainTrailer(actualBody)).toBe("row-abc");
  });

  it("bisect sub-attempts land under the PARENT train's label, not the sub-attempt suffix", async () => {
    await git(["branch", "f-good"]);
    await commitFile("f-good", "good.txt", "good\n");
    await git(["checkout", "-q", "main"]);

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w-good", branch: "f-good", issueNumber: 42 }],
      label: "train/2026-09-17-03a",
      trainId: "row-xyz",
      runGate: async () => ({ passed: true, message: "ok" }),
      closeMember: async () => {},
    });

    expect(result.landed.map((m) => m.workspaceId)).toEqual(["w-good"]);
    const subject = (await gitExecOrThrow(["log", "-1", "--format=%s", "main"], { cwd: repo })).trim();
    expect(subject).toBe("Merge train 2026-09-17-03: #42");
    // The body still says WHICH sub-attempt landed, so a bisected train is traceable.
    const body = (await gitExecOrThrow(["log", "-1", "--format=%B", "main"], { cwd: repo })).trim();
    expect(body).toContain("Attempt: train/2026-09-17-03a");
    expect(parseMergeTrainTrailer(body)).toBe("row-xyz");
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
