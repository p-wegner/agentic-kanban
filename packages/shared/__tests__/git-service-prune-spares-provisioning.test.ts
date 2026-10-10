// #1342 — #1339's per-repo lock was not enough: the post-merge cleanup of A (worktree removal,
// the dangling-registration prune, the branch delete) could still unregister a worktree B that
// was mid-provision, because a registration whose `.git` file is not there yet is
// indistinguishable from a dead one. The generic prune is now age-bounded.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  deleteBranch,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "../src/lib/git-service.js";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolvePromise(stdout.toString());
    });
  });
}

describe("post-merge cleanup spares a worktree that is still being provisioned (#1342)", () => {
  let repo: string;

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), "ak-wt-prune-age-"));
    repo = join(parent, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await writeFile(join(repo, "app.txt"), "marker\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "initial commit"]);
    await git(repo, ["branch", "-M", "main"]);
  });

  /** Strip the worktree's own `.git` file: the state inside the `worktree add` window. */
  async function halfProvision(path: string): Promise<{ path: string; adminDir: string }> {
    await rm(join(path, ".git"), { force: true });
    return { path, adminDir: join(repo, ".git", "worktrees", resolve(path).split(/[\\/]/).pop()!) };
  }

  it("pruneWorktrees keeps a fresh registration but still prunes an old dead one", async () => {
    const fresh = await halfProvision(await createWorktree(repo, "feature/ak-2-fresh", "main"));
    const old = await halfProvision(await createWorktree(repo, "feature/ak-3-old", "main"));
    expect(existsSync(fresh.adminDir)).toBe(true);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    // git ages a registration by the mtime of its `index` (falling back to `gitdir`).
    for (const f of ["gitdir", "index"]) await utimes(join(old.adminDir, f), longAgo, longAgo).catch(() => undefined);

    await pruneWorktrees(repo);

    expect(existsSync(fresh.adminDir)).toBe(true);
    expect(existsSync(old.adminDir)).toBe(false);
  });

  it("merge cleanup of A (remove worktree, prune, delete branch) leaves a mid-provision B registered", async () => {
    await git(repo, ["branch", "feature/ak-1-merged", "main"]);
    const mergedPath = await createWorktree(repo, "feature/ak-1-merged", "main");
    const b = await halfProvision(await createWorktree(repo, "feature/ak-2-b", "main"));

    // A's directory vanishes without git knowing (Windows lock fallback); the cleanup then
    // removes the worktree, prunes dangling registrations and deletes the merged branch.
    await rm(mergedPath, { recursive: true, force: true });
    await removeWorktree(repo, mergedPath).catch(() => undefined);
    await pruneWorktrees(repo);
    await deleteBranch(repo, "feature/ak-1-merged", { force: true });

    const registered = (await listWorktrees(repo)).map((w) => resolve(w.path).toLowerCase());
    expect(registered).toContain(resolve(b.path).toLowerCase());
    expect(existsSync(b.adminDir)).toBe(true);
  });
});
