// Regression tests for the multi-repo worktree collision (adversarial finding #1):
// createWorktree places worktrees at dirname(repoPath)/.worktrees/<sanitized-branch>,
// so two repos sharing ONE parent directory (the guaranteed layout for clone-from-URL
// repos) and the SAME branch name computed the identical path — and the second call
// blind-rm'd the first repo's just-created worktree before checking out its own there.
//
// Fixes under test:
//  1. createWorktree never deletes an existing directory that is another repo's
//     checkout (or a registered worktree of this repo under a different branch) —
//     it falls back to a numeric-suffix path instead.
//  2. EVERY worktree is namespaced by its repo's directory name (#385):
//     .worktrees/<repoDirName>/<branch>, so sibling repos can't collide at all and a
//     path states its own owner. `pathNamespace` adds a further sub-segment.
//  3. Old-layout worktrees (.worktrees/<branch>, pre-#385) still RESOLVE — the reuse
//     path goes through `git worktree list`, not the computed path.
//  4. A plain leftover directory (no .git) at the target is still removed and reused.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, listWorktrees } from "../src/lib/git-service.js";

/**
 * Per-test budget for this real-git suite (#206 tail). Its cost is `git` spawn latency, not
 * the code under test: measured standalone on an IDLE machine it needs ~64s of test time, so
 * the previous hand-set 30s cap failed under any parallel load — and `pnpm test:mine` doubles
 * as the merge verify_script, so that turned into a withheld merge for unrelated diffs.
 * A hang still never completes, so this only removes the false red.
 */
const GIT_IO_TIMEOUT_MS = Number(process.env.VITEST_GIT_IO_TIMEOUT) || 120_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolvePromise(stdout.toString());
    });
  });
}

/** Init a repo at parent/<name> with a marker file named after the repo. */
async function initRepoAt(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await git(dir, ["init"]);
  await writeFile(join(dir, `${name}.txt`), `marker for ${name}\n`);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "initial commit"]);
  await git(dir, ["branch", "-M", "main"]);
  return dir;
}

describe("createWorktree collision safety (repos sharing a parent directory)", () => {
  let parent: string;
  let appRepo: string;
  let libRepo: string;

  beforeEach(async () => {
    // BOTH repos under ONE parent — they share the same `.worktrees` root. The old
    // unit tests nested every repo under its own mkdtemp parent, which is exactly
    // why this collision was never caught.
    parent = await mkdtemp(join(tmpdir(), "ak-wt-collision-"));
    appRepo = await initRepoAt(parent, "app");
    libRepo = await initRepoAt(parent, "lib");
  }, GIT_IO_TIMEOUT_MS);

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("namespaces the single-repo path by the repo directory: <parent>/.worktrees/<repoDir>/<sanitized-branch> (#385)", async () => {
    const wt = await createWorktree(appRepo, "feature/solo", "main");

    expect(resolve(wt)).toBe(resolve(join(parent, ".worktrees", "app", "feature_solo")));
    expect(existsSync(join(wt, "app.txt"))).toBe(true);
  }, GIT_IO_TIMEOUT_MS);

  it("shortens the on-disk leaf to just ak-<N> for a branch carrying an issue number (#193)", async () => {
    const wt = await createWorktree(appRepo, "feature/ak-1-a-very-long-descriptive-slug-goes-here", "main");

    expect(resolve(wt)).toBe(resolve(join(parent, ".worktrees", "app", "ak-1")));
    expect(existsSync(join(wt, "app.txt"))).toBe(true);
  }, GIT_IO_TIMEOUT_MS);

  it("gives two projects' identical issue number DISTINCT, self-identifying paths — no numeric suffix (#385)", async () => {
    // The #385 hazard verbatim: issue numbers are allocated PER PROJECT, so both
    // sibling repos have an issue #6 and both branches sanitize to the leaf `ak-6`.
    // Pre-#385 the second claimant got `.worktrees/ak-6-2` and the un-suffixed
    // `.worktrees/ak-6` belonged to whichever repo got there first.
    const branch = "feature/ak-6-same-slug-different-project";
    const wtApp = await createWorktree(appRepo, branch, "main");
    const wtLib = await createWorktree(libRepo, branch, "main");

    expect(resolve(wtApp)).toBe(resolve(join(parent, ".worktrees", "app", "ak-6")));
    expect(resolve(wtLib)).toBe(resolve(join(parent, ".worktrees", "lib", "ak-6")));
    // Neither path needed a collision suffix, and each names its owner.
    expect(existsSync(join(wtApp, "app.txt"))).toBe(true);
    expect(existsSync(join(wtLib, "lib.txt"))).toBe(true);
  }, GIT_IO_TIMEOUT_MS);

  it("still resolves (reuses) an OLD-LAYOUT worktree at .worktrees/<branch> instead of creating a second one (#385 migration)", async () => {
    // Simulate a worktree created before the layout change by registering it at the
    // flat pre-#385 path directly with git.
    const oldLayoutPath = join(parent, ".worktrees", "ak-9");
    await git(appRepo, ["branch", "feature/ak-9-legacy", "main"]);
    await git(appRepo, ["worktree", "add", oldLayoutPath, "feature/ak-9-legacy"]);

    const wt = await createWorktree(appRepo, "feature/ak-9-legacy", "main");

    // Resolution goes through `git worktree list`, so the existing checkout is reused
    // where it already sits — the new layout applies only to NEW worktrees.
    expect(resolve(wt)).toBe(resolve(oldLayoutPath));
    expect(existsSync(join(parent, ".worktrees", "app", "ak-9"))).toBe(false);
    const registered = await listWorktrees(appRepo);
    expect(registered.filter((w) => w.branch.endsWith("feature/ak-9-legacy")).length).toBe(1);
  }, GIT_IO_TIMEOUT_MS);

  it("does not destroy the first repo's worktree when a sibling repo uses the same branch", async () => {
    const wtApp = await createWorktree(appRepo, "feature/shared", "main");
    expect(existsSync(join(wtApp, "app.txt"))).toBe(true);

    // Same branch, sibling repo, same parent — previously this rm -rf'd wtApp and
    // checked out lib at the identical path.
    const wtLib = await createWorktree(libRepo, "feature/shared", "main");

    // Distinct paths, and each checkout belongs to its own repo.
    expect(resolve(wtLib)).not.toBe(resolve(wtApp));
    expect(existsSync(join(wtApp, "app.txt"))).toBe(true);
    expect(existsSync(join(wtApp, "lib.txt"))).toBe(false);
    expect(existsSync(join(wtLib, "lib.txt"))).toBe(true);
    expect(existsSync(join(wtLib, "app.txt"))).toBe(false);

    // The app repo's worktree registration must still be intact (not corrupted by
    // the sibling's checkout landing in its directory).
    const appWorktrees = await listWorktrees(appRepo);
    expect(appWorktrees.some((wt) => resolve(wt.path) === resolve(wtApp))).toBe(true);
    expect((await git(wtApp, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/shared");
    expect((await git(wtLib, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/shared");
  }, GIT_IO_TIMEOUT_MS);

  it("pathNamespace adds a further sub-segment under the repo namespace", async () => {
    const wtApp = await createWorktree(appRepo, "feature/multi", "main");
    const wtLib = await createWorktree(libRepo, "feature/multi", "main", { pathNamespace: "train" });

    expect(resolve(wtApp)).toBe(resolve(join(parent, ".worktrees", "app", "feature_multi")));
    expect(resolve(wtLib)).toBe(resolve(join(parent, ".worktrees", "lib", "train", "feature_multi")));
    expect(existsSync(join(wtApp, "app.txt"))).toBe(true);
    expect(existsSync(join(wtLib, "lib.txt"))).toBe(true);
  }, GIT_IO_TIMEOUT_MS);

  it("still removes and reuses a plain leftover directory (no .git) at the target path", async () => {
    const target = join(parent, ".worktrees", "app", "feature_leftover");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "junk.txt"), "leftover from a deleted workspace\n");

    const wt = await createWorktree(appRepo, "feature/leftover", "main");

    expect(resolve(wt)).toBe(resolve(target));
    expect(existsSync(join(wt, "junk.txt"))).toBe(false);
    expect(existsSync(join(wt, "app.txt"))).toBe(true);
  }, GIT_IO_TIMEOUT_MS);

  it("does not delete this repo's own worktree of a DIFFERENT branch that sanitizes to the same directory name", async () => {
    // "feature/x" and "feature_x" both sanitize to "feature_x".
    const wtSlash = await createWorktree(appRepo, "feature/x", "main");
    const wtUnderscore = await createWorktree(appRepo, "feature_x", "main");

    expect(resolve(wtUnderscore)).not.toBe(resolve(wtSlash));
    expect(existsSync(join(wtSlash, "app.txt"))).toBe(true);
    expect((await git(wtSlash, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/x");
    expect((await git(wtUnderscore, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature_x");
  }, GIT_IO_TIMEOUT_MS);
});
