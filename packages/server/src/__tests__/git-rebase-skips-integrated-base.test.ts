// @covers git-integration.rebase.already-integrated [workflow,regression]
//
// #933 — the fix-and-merge <-> review-preflight deadlock.
//
// A branch can enter a state where the board's two recovery paths contradict each other and
// neither can ever win:
//   1. POST /:id/review aborts with "Rebase conflict during review preflight ... Route to
//      fix-and-merge to resolve."
//   2. POST /:id/fix-and-merge resolves the conflict by MERGING the base into the branch and
//      reports success (clean tree, no conflict markers remain).
//   3. POST /:id/review aborts again with the IDENTICAL conflict. Loop forever.
//
// Root cause: the merge commit resolves the conflict in the MERGE direction, but the preflight
// REBASES, which replays the branch's original raw commit onto the base and re-hits the same
// conflict. Hit live on #905: merge-base(master, branch) == master tip (so `git merge-tree
// master branch` was CLEAN) while `git rebase master` still conflicted.
//
// The fix: when the base is already an ancestor of HEAD there is nothing to bring in, so both
// rebase entry points skip the rebase instead of replaying pre-resolution commits.
//
// Real temp git repos only (no mocks) — the defect is entirely in git's replay semantics, so a
// mocked git could not observe it. Assertions match on filenames/content keywords, never on
// CRLF-sensitive exact strings, and the base branch name is resolved live.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import * as gitService from "../services/git.service.js";
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

async function createTempRepo(): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kanban-rebase-integrated-"));
  await exec("git", ["init"], dir);
  writeFileSync(join(dir, "shared.txt"), "original\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  const base = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
  return { dir, base };
}

async function commitFile(wt: string, file: string, content: string, msg: string): Promise<void> {
  writeFileSync(join(wt, file), content);
  await exec("git", ["add", "."], wt);
  await exec("git", ["commit", "-m", msg], wt);
}

/**
 * Reproduce the exact #933 state: the branch commit and the base BOTH edit file F, and the
 * conflict is then resolved the way fix-and-merge resolves it — by merging the base INTO the
 * branch. Leaves the worktree clean, with the resolved content committed as a merge commit.
 */
async function buildMergeResolvedBranch(
  repo: string,
  base: string,
  branch: string,
): Promise<{ worktree: string; resolvedContent: string }> {
  const worktree = await gitService.createWorktree(repo, branch, base);

  // Both sides edit the SAME file divergently -> a rebase of the raw commit must conflict.
  await commitFile(worktree, "shared.txt", "the branch's version\n", "feat: branch edits shared.txt");
  await commitFile(repo, "shared.txt", "the base's version\n", "chore: base edits shared.txt");

  // fix-and-merge's resolution: merge the base INTO the branch, resolve, commit.
  const resolvedContent = "the resolution keeping both intents\n";
  let mergeConflicted = false;
  try {
    await exec("git", ["merge", base, "-m", "merge base into branch"], worktree);
  } catch {
    mergeConflicted = true; // Expected: CONFLICT, exactly the state fix-and-merge is handed.
  }
  expect(mergeConflicted, "fixture precondition: merging base into branch must conflict").toBe(true);

  // Resolve it the way the fix-and-merge agent does: pick the resolved content, stage, commit.
  writeFileSync(join(worktree, "shared.txt"), resolvedContent);
  await exec("git", ["add", "shared.txt"], worktree);
  await exec("git", ["commit", "--no-edit"], worktree);

  return { worktree, resolvedContent };
}

describe("#933 rebase entry points skip a base that is already integrated", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length) {
      const p = cleanups.pop()!;
      try { await rm(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("prepareForReview does NOT report a conflict after fix-and-merge resolved it by merging", async () => {
    const { dir: repo, base } = await createTempRepo();
    cleanups.push(repo);
    const { worktree, resolvedContent } = await buildMergeResolvedBranch(repo, base, "feature/ak-933-review");
    cleanups.push(worktree);

    // Precondition — this is the state the ticket describes: the base tip IS the merge-base,
    // so the branch's MERGE into base is clean, yet its raw commit would still rebase-conflict.
    const baseTip = (await exec("git", ["rev-parse", base], repo)).trim();
    const mergeBase = (await exec("git", ["merge-base", base, "HEAD"], worktree)).trim();
    expect(mergeBase).toBe(baseTip);

    const res = await gitService.prepareForReview(worktree, base);

    // The acceptance: a branch whose merge-base equals the base tip is never reported as a
    // rebase conflict.
    expect(res.success).toBe(true);
    expect(res.conflictingFiles ?? []).toEqual([]);
    expect(res.diffRef).toBe(base);

    // The already-resolved content survived — the raw pre-resolution commit was NOT replayed.
    expect(readFileSync(join(worktree, "shared.txt"), "utf8")).toContain("resolution keeping both intents");
    expect(readFileSync(join(worktree, "shared.txt"), "utf8")).toBe(resolvedContent);

    // Clean tree, no half-rebase stranded behind.
    expect((await exec("git", ["status", "--porcelain"], worktree)).trim()).toBe("");
    expect(await gitService.isRebaseInProgress(worktree)).toBe(false);

    // And the branch is still genuinely mergeable into the base.
    expect(await gitService.isAncestor(worktree, base, "HEAD")).toBe(true);
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it("rebaseOntoBase reports success (not a conflict) for the same already-integrated branch", async () => {
    const { dir: repo, base } = await createTempRepo();
    cleanups.push(repo);
    const branch = "feature/ak-933-merge";
    const { worktree, resolvedContent } = await buildMergeResolvedBranch(repo, base, branch);
    cleanups.push(worktree);

    const res = await gitService.rebaseOntoBase(worktree, base, branch, { preferLocalBase: true });

    expect(res.success).toBe(true);
    expect(res.conflictingFiles ?? []).toEqual([]);
    expect(readFileSync(join(worktree, "shared.txt"), "utf8")).toBe(resolvedContent);
    // Left attached to its branch, not detached mid-rebase.
    expect((await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim()).toBe(branch);
    expect(await gitService.isRebaseInProgress(worktree)).toBe(false);
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it("still rebases (and still reports a real conflict) when the base is NOT yet integrated", async () => {
    const { dir: repo, base } = await createTempRepo();
    cleanups.push(repo);
    const worktree = await gitService.createWorktree(repo, "feature/ak-933-genuine", base);
    cleanups.push(worktree);

    // Divergent edits to the same file, with NO merge resolving them — the guard must not fire.
    await commitFile(worktree, "shared.txt", "branch side\n", "feat: branch edits shared.txt");
    await commitFile(repo, "shared.txt", "base side\n", "chore: base edits shared.txt");

    const res = await gitService.prepareForReview(worktree, base);

    expect(res.success).toBe(false);
    expect(res.conflictingFiles).toContain("shared.txt");
    expect((await exec("git", ["status", "--porcelain"], worktree)).trim()).toBe("");
    expect(await gitService.isRebaseInProgress(worktree)).toBe(false);
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it("still replays branch commits onto an advanced base that the branch has not integrated", async () => {
    const { dir: repo, base } = await createTempRepo();
    cleanups.push(repo);
    const worktree = await gitService.createWorktree(repo, "feature/ak-933-clean", base);
    cleanups.push(worktree);

    // Different files -> a clean rebase. The guard must NOT short-circuit it: the branch has to
    // come out sitting on top of the advanced base.
    await commitFile(worktree, "feature.txt", "feature work\n", "feat: feature work");
    await commitFile(repo, "base-advance.txt", "advanced\n", "chore: advance base");
    const baseTip = (await exec("git", ["rev-parse", base], repo)).trim();

    const res = await gitService.prepareForReview(worktree, base);

    expect(res.success).toBe(true);
    // The advanced base tip is now an ancestor of the branch — it really was replayed on top.
    expect(await gitService.isAncestor(worktree, baseTip, "HEAD")).toBe(true);
    const tracked = (await exec("git", ["ls-files"], worktree)).trim();
    expect(tracked).toContain("base-advance.txt");
    expect(tracked).toContain("feature.txt");
  }, GIT_HEAVY_TEST_TIMEOUT_MS);
});
