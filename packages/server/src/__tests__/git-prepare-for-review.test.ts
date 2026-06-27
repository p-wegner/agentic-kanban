// @covers git-integration.rebase.prepare-review [workflow,error-handling,regression]
//
// prepareForReview sits on the build->review->merge critical path: it rebases a feature
// worktree onto the base branch before review. Two paths were previously UNASSERTED and are
// covered here (the existing git.service.test.ts only exercised rebaseOntoBase's dirty-tree
// leftover-commit branch):
//   1. local-vs-origin base CHOICE — in this local-first app (manual merge, no push) the
//      board merges into the LOCAL base branch, which can be many commits ahead of a stale
//      origin/*. prepareForReview must rebase onto the LOCAL ref (diffRef === baseBranch),
//      not origin/<base>, so local-only history is the base and doesn't replay/conflict.
//   2. on a real rebase CONFLICT it must collect the --diff-filter=U conflicting-file list,
//      abort the rebase, and return { success:false, conflictingFiles } — leaving a CLEAN
//      tree (no half-rebase) rather than throwing or stranding the workspace.
//
// Real temp git repos only (no mocks). Assertions match on keywords/filenames, never exact
// CRLF-sensitive strings, and the base branch is resolved live (never assumed to be 'main').

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import * as gitService from "../services/git.service.js";

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

/** Create a temp git repo with a single commit; return { dir, base } where base is the live
 *  default-branch name (resolved, NOT assumed to be 'main'/'master'). */
async function createTempRepo(): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kanban-prep-review-"));
  await exec("git", ["init"], dir);
  await exec("git", ["config", "user.email", "test@test.com"], dir);
  await exec("git", ["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "foo.txt"), "base\n");
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

describe("prepareForReview (git-integration.rebase.prepare-review)", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length) {
      const p = cleanups.pop()!;
      try { await rm(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("rebases onto the LOCAL base branch (ahead of a stale origin), not origin/<base>", async () => {
    const { dir: repo, base } = await createTempRepo();
    cleanups.push(repo);

    // Stand up an origin that is STALE: it captures the base at the initial commit only.
    const origin = await mkdtemp(join(tmpdir(), "kanban-prep-review-origin-"));
    cleanups.push(origin);
    await exec("git", ["clone", "--bare", repo, origin], repo);
    await exec("git", ["remote", "add", "origin", origin], repo);

    // Feature worktree branches from the base at the initial commit.
    const wt = await gitService.createWorktree(repo, "feature/local-base", base);
    cleanups.push(wt);

    // LOCAL base advances AFTER the worktree was cut (origin stays behind). Touch a DIFFERENT
    // file than the feature so the rebase is clean — the point is the BASE CHOICE, not conflict.
    await commitFile(repo, "base-advance.txt", "advanced locally\n", "chore: advance local base");
    const localBaseTip = (await exec("git", ["rev-parse", base], repo)).trim();

    // Feature work on its own file.
    await commitFile(wt, "feature.txt", "feature work\n", "feat: feature work");

    const res = await gitService.prepareForReview(wt, base);

    expect(res.success).toBe(true);
    // diffRef is the LOCAL base name, never "origin/<base>".
    expect(res.diffRef).toBe(base);
    expect(res.diffRef).not.toBe(`origin/${base}`);

    // The local base tip is now an ANCESTOR of the rebased feature HEAD — i.e. the feature was
    // replayed onto local base (which holds base-advance.txt), not onto the stale origin.
    await exec("git", ["merge-base", "--is-ancestor", localBaseTip, "HEAD"], wt);
    const tracked = (await exec("git", ["ls-files"], wt)).trim();
    expect(tracked).toContain("base-advance.txt"); // local-only base history is present
    expect(tracked).toContain("feature.txt");

    const status = (await exec("git", ["status", "--porcelain"], wt)).trim();
    expect(status).toBe("");
  }, 40000);

  it("on a rebase conflict returns the --diff-filter=U file list and leaves a clean tree (no half-rebase)", async () => {
    const { dir: repo, base } = await createTempRepo();
    cleanups.push(repo);

    // Feature worktree off the base's initial commit (foo.txt = "base").
    const wt = await gitService.createWorktree(repo, "feature/conflict", base);
    cleanups.push(wt);

    // Both sides edit foo.txt divergently -> rebase MUST conflict on foo.txt.
    await commitFile(repo, "foo.txt", "base advanced on master side\n", "chore: base edits foo");
    await commitFile(wt, "foo.txt", "feature edits the same line\n", "feat: feature edits foo");

    const res = await gitService.prepareForReview(wt, base);

    expect(res.success).toBe(false);
    expect(res.diffRef).toBe(base); // chose local base even on the failing path
    expect(res.conflictingFiles).toBeDefined();
    expect(res.conflictingFiles).toContain("foo.txt");
    // It does NOT strand a half-rebase: tree is clean and no rebase is in progress.
    const status = (await exec("git", ["status", "--porcelain"], wt)).trim();
    expect(status).toBe("");
    expect(await gitService.isRebaseInProgress(wt)).toBe(false);
  }, 40000);
});
