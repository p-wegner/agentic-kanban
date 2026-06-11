/**
 * Regression test for ticket #761: merge endpoint auto-rebase re-conflict loop
 * strands file-overlapping workspaces.
 *
 * Real-git integration (no mocks for git). It proves that the conflict pre-check
 * used by the /merge path ({@link detectWorkspaceMergeConflicts}) is now READ-ONLY
 * and converges, so a cluster of file-overlapping workspaces lands through the
 * board's plumbing merge without the destructive in-place rebase that previously
 * re-reported the same conflicting files every cycle.
 *
 * Scenarios:
 *   1. Overlap cluster, mechanically mergeable: two branches edit DIFFERENT regions
 *      of the same file. Landing the first advances base; the second is then "behind"
 *      but git can merge-tree it cleanly → detect reports `clear`, mergeBranch lands it.
 *      The old code rebased-in-place and could loop; the new code never rebases.
 *   2. Already-merged-clean branch: a branch that already contains all of base (base
 *      was merged into it) reports `clear` and fast-forwards via the plumbing merge —
 *      it does NOT re-enter an auto-rebase.
 *   3. The conflict check does not mutate the worktree branch (idempotent): calling it
 *      repeatedly leaves the branch tip unchanged, so repeated /merge attempts converge.
 *   4. A genuinely conflicting member still reports `conflict` (same files every call).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import * as gitService from "../services/git.service.js";
import { detectWorkspaceMergeConflicts } from "../services/workspace-merge-conflict.service.js";

function exec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

/** A minimal workspace row shape — only the fields the conflict service reads. */
function ws(branch: string, workingDir: string) {
  return { branch, workingDir, isDirect: false } as never;
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), content);
  await exec(["add", "-A"], cwd);
  await exec(["commit", "-m", message], cwd);
}

describe("#761 overlap-cluster landing without re-conflict loop", () => {
  let repo: string;
  let wtA: string;
  let wtB: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "kanban-761-repo-"));
    await exec(["init"], repo);
    await exec(["config", "user.email", "t@t.com"], repo);
    await exec(["config", "user.name", "Test"], repo);
    await exec(["branch", "-M", "master"], repo).catch(() => {});

    // Seed a shared file with several lines so two branches can edit non-adjacent
    // regions (mechanically mergeable) — the jump-run-html5 src/levels.js shape.
    await commitFile(repo, "levels.js", "line1\nline2\nline3\nline4\nline5\n", "seed");
    await exec(["branch", "-M", "master"], repo).catch(() => {});

    // Two feature worktrees branched from the same base commit.
    wtA = join(repo, "..", `wt-a-${Date.now()}`);
    wtB = join(repo, "..", `wt-b-${Date.now()}`);
    await exec(["worktree", "add", "-b", "feature/a", wtA, "master"], repo);
    await exec(["worktree", "add", "-b", "feature/b", wtB, "master"], repo);

    // A edits the TOP region; B edits the BOTTOM region — no textual overlap, so a
    // 3-way merge resolves mechanically even after one lands and base moves.
    await commitFile(wtA, "levels.js", "A1\nline2\nline3\nline4\nline5\n", "A: edit top");
    await commitFile(wtB, "levels.js", "line1\nline2\nline3\nline4\nB5\n", "B: edit bottom");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
    await rm(wtA, { recursive: true, force: true }).catch(() => {});
    await rm(wtB, { recursive: true, force: true }).catch(() => {});
  });

  it("lands a mechanically-mergeable overlap cluster without rebasing or looping", async () => {
    // Land A first (clean — A is ahead of base by one commit).
    let res = await detectWorkspaceMergeConflicts({ workspace: ws("feature/a", wtA), repoPath: repo, baseBranch: "master", gitService });
    expect(res.kind).toBe("clear");
    await gitService.mergeBranch(repo, "feature/a", "master");

    // Now base has advanced. B touches the SAME file and is "behind", but git can
    // merge-tree it cleanly. The pre-check must report clear (not re-conflict), and
    // must NOT rewrite B's branch tip.
    const bTipBefore = (await exec(["rev-parse", "feature/b"], repo)).trim();
    res = await detectWorkspaceMergeConflicts({ workspace: ws("feature/b", wtB), repoPath: repo, baseBranch: "master", gitService });
    expect(res.kind).toBe("clear");
    const bTipAfter = (await exec(["rev-parse", "feature/b"], repo)).trim();
    expect(bTipAfter).toBe(bTipBefore); // read-only: branch was not rebased

    // B lands via the plumbing merge; master ends up containing BOTH edits.
    await gitService.mergeBranch(repo, "feature/b", "master");
    const merged = await exec(["show", "master:levels.js"], repo);
    expect(merged).toContain("A1");
    expect(merged).toContain("B5");
  });

  it("repeated conflict checks converge (idempotent) — no re-conflict loop", async () => {
    await gitService.mergeBranch(repo, "feature/a", "master");
    const tip = (await exec(["rev-parse", "feature/b"], repo)).trim();
    for (let i = 0; i < 3; i++) {
      const res = await detectWorkspaceMergeConflicts({ workspace: ws("feature/b", wtB), repoPath: repo, baseBranch: "master", gitService });
      expect(res.kind).toBe("clear");
      // branch tip never moves — the check is read-only every time
      expect((await exec(["rev-parse", "feature/b"], repo)).trim()).toBe(tip);
    }
  });

  it("a branch already merged-clean with master reports clear (fast-forwards, no auto-rebase)", async () => {
    // Merge master INTO feature/b's worktree so the branch already contains all of base
    // (the "manually merged clean with master" case from acceptance #3).
    await gitService.mergeBranch(repo, "feature/a", "master");
    await exec(["merge", "master", "--no-edit"], wtB);
    await gitService.syncBranchToHead(wtB, "feature/b");
    const tip = (await exec(["rev-parse", "feature/b"], repo)).trim();

    const res = await detectWorkspaceMergeConflicts({ workspace: ws("feature/b", wtB), repoPath: repo, baseBranch: "master", gitService });
    expect(res.kind).toBe("clear");
    expect((await exec(["rev-parse", "feature/b"], repo)).trim()).toBe(tip); // not rebased
  });

  it("a genuinely conflicting member still reports conflict with the same files each call", async () => {
    // Make A and B edit the SAME line so the 3-way merge truly conflicts.
    await commitFile(wtA, "levels.js", "CONFLICT_A\nline2\nline3\nline4\nline5\n", "A: same line");
    await commitFile(wtB, "levels.js", "CONFLICT_B\nline2\nline3\nline4\nline5\n", "B: same line");
    await gitService.syncBranchToHead(wtA, "feature/a");
    await gitService.syncBranchToHead(wtB, "feature/b");
    await gitService.mergeBranch(repo, "feature/a", "master");

    const first = await detectWorkspaceMergeConflicts({ workspace: ws("feature/b", wtB), repoPath: repo, baseBranch: "master", gitService });
    const second = await detectWorkspaceMergeConflicts({ workspace: ws("feature/b", wtB), repoPath: repo, baseBranch: "master", gitService });
    expect(first.kind).toBe("conflict");
    expect(second).toEqual(first); // converges — same verdict, same files
    if (first.kind === "conflict") expect(first.conflictFiles).toContain("levels.js");
  });
});
