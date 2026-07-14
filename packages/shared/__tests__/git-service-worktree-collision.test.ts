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
//  2. The opt-in `pathNamespace` option places a worktree at
//     .worktrees/<namespace>/<branch> so sibling repos can't collide at all.
//  3. The single-repo path scheme (<parent>/.worktrees/<branch>) is UNCHANGED.
//  4. A plain leftover directory (no .git) at the target is still removed and reused.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, listWorktrees } from "../src/lib/git-service.js";

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
  await git(dir, ["config", "user.email", "test@example.local"]);
  await git(dir, ["config", "user.name", "Worktree Collision Test"]);
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
  }, 30000);

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("keeps the single-repo path scheme unchanged: <parent>/.worktrees/<sanitized-branch>", async () => {
    const wt = await createWorktree(appRepo, "feature/ak-1-solo", "main");

    expect(resolve(wt)).toBe(resolve(join(parent, ".worktrees", "feature_ak-1-solo")));
    expect(existsSync(join(wt, "app.txt"))).toBe(true);
  }, 30000);

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
  }, 30000);

  it("pathNamespace places the worktree under .worktrees/<namespace>/<branch>, avoiding collision entirely", async () => {
    const wtApp = await createWorktree(appRepo, "feature/multi", "main");
    const wtLib = await createWorktree(libRepo, "feature/multi", "main", { pathNamespace: "lib" });

    expect(resolve(wtLib)).toBe(resolve(join(parent, ".worktrees", "lib", "feature_multi")));
    expect(existsSync(join(wtApp, "app.txt"))).toBe(true);
    expect(existsSync(join(wtLib, "lib.txt"))).toBe(true);
  }, 30000);

  it("still removes and reuses a plain leftover directory (no .git) at the target path", async () => {
    const target = join(parent, ".worktrees", "feature_leftover");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "junk.txt"), "leftover from a deleted workspace\n");

    const wt = await createWorktree(appRepo, "feature/leftover", "main");

    expect(resolve(wt)).toBe(resolve(target));
    expect(existsSync(join(wt, "junk.txt"))).toBe(false);
    expect(existsSync(join(wt, "app.txt"))).toBe(true);
  }, 30000);

  it("does not delete this repo's own worktree of a DIFFERENT branch that sanitizes to the same directory name", async () => {
    // "feature/x" and "feature_x" both sanitize to "feature_x".
    const wtSlash = await createWorktree(appRepo, "feature/x", "main");
    const wtUnderscore = await createWorktree(appRepo, "feature_x", "main");

    expect(resolve(wtUnderscore)).not.toBe(resolve(wtSlash));
    expect(existsSync(join(wtSlash, "app.txt"))).toBe(true);
    expect((await git(wtSlash, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/x");
    expect((await git(wtUnderscore, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature_x");
  }, 30000);
});
