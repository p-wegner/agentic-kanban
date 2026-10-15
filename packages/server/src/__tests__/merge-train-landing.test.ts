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

describe("merge train landing", () => {

  /**
   * A Bullseye save commits only `scripts/board-monitor/objective.md` to the base. When that lands
   * during a 25-40 min train gate, the move cannot change the verdict (base-move-relevance.ts), so
   * the gated members are re-assembled onto the new base and land without a second gate. A move
   * that touches a gate input still refuses, exactly as before.
   */
  it("lands without a re-gate when the base moved only by objective.md during the gate", async () => {
    await git(["branch", "f1"]);
    await commitFile("f1", "a.txt", "a\n");
    await git(["checkout", "-q", "main"]);

    let gateRuns = 0;
    const closed: string[] = [];
    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }],
      label: "t-neutral",
      runGate: async () => {
        gateRuns++;
        await git(["checkout", "-q", "main"]);
        mkdirSync(join(repo, "scripts", "board-monitor"), { recursive: true });
        writeFileSync(join(repo, "scripts", "board-monitor", "objective.md"), "# objective\n", "utf8");
        await git(["add", "scripts/board-monitor/objective.md"]);
        await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore(monitor): sync objective.md"]);
        return { passed: true, message: "ok" };
      },
      closeMember: async (id) => { closed.push(id); },
    });

    expect(gateRuns).toBe(1);
    expect(result.gateRuns).toBe(1);
    expect(result.landed.map((m) => m.branch)).toEqual(["f1"]);
    expect(closed).toEqual(["w1"]);
    expect(await isAncestor(repo, await revParse(repo, "f1"), "main")).toBe(true);
    // The Bullseye commit is still on the base, under the landed train.
    const baseLog = String(await git(["log", "--format=%s", "main"]));
    expect(baseLog).toContain("chore(monitor): sync objective.md");
  });

  it("still refuses when the base moved by a code file during the gate", async () => {
    await git(["branch", "f1"]);
    await commitFile("f1", "a.txt", "a\n");
    await git(["checkout", "-q", "main"]);

    let gateRuns = 0;
    await expect(
      runMergeTrain({
        repoPath: repo,
        baseBranch: "main",
        members: [{ workspaceId: "w1", branch: "f1" }],
        label: "t-relevant",
        runGate: async () => {
          gateRuns++;
          await commitFile("main", "code.ts", "export const x = 1;\n");
          return { passed: true, message: "ok" };
        },
        closeMember: async () => {},
      }),
    ).rejects.toThrow(/base 'main' moved/);
    expect(gateRuns).toBe(1);
    expect(await isAncestor(repo, await revParse(repo, "f1"), "main")).toBe(false);
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

  /**
   * #1185 — a lone member that CONFLICTS during assembly (never reaches the gate at all) must
   * be reported as `dropped` with its conflict reason, not `gateRejected`. Before the fix, a
   * bisect that halved down to this single member saw `attempt.gateFailure ===
   * "no members could be assembled onto the train"` and, because `subset.length === 1`, filed
   * it under `gateRejected` — telling the author to fix a gate that never ran instead of
   * rebasing the conflict.
   */
  it("attributes a conflict-only singleton to dropped, not gateRejected, when bisected down to it (#1185)", async () => {
    await git(["branch", "f1"]);
    await git(["branch", "f2"]);
    // f1 and f2 both touch shared.txt — f2 will conflict when merged onto a train that already
    // has f1's change, so bisecting a red batch down to {f2} alone reproduces the same conflict.
    await commitFile("f1", "shared.txt", "from f1\n");
    await commitFile("f2", "shared.txt", "from f2\n");
    await git(["checkout", "-q", "main"]);

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [
        { workspaceId: "w1", branch: "f1" },
        { workspaceId: "w2", branch: "f2", issueNumber: 42 },
      ],
      label: "t1185",
      // The gate never runs for a member whose assembly fails — this asserts that.
      runGate: async () => ({ passed: true, message: "ok" }),
      closeMember: async () => {},
    });

    // f1 lands (no conflict); f2 conflicts against the train and must show up as dropped.
    expect(result.landed.map((m) => m.workspaceId)).toEqual(["w1"]);
    expect(result.gateRejected).toEqual([]);
    expect(result.dropped.some((d) => d.member.workspaceId === "w2")).toBe(true);
  });
}, 240000);
