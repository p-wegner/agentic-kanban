// #1339 — merging workspace A destroyed the fresh worktrees of B and C being provisioned.
//
// `git worktree add` registers `.git/worktrees/<name>` before the worktree's own `.git` file
// exists; a `git worktree prune` in that window deletes the registration. The post-merge
// cleanup of A runs `removeWorktree` + `pruneWorktrees`, so every add / remove / prune on one
// repo is now serialized by `withWorktreeAdminLock`.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  withWorktreeAdminLock,
} from "../src/lib/git-service.js";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolvePromise(stdout.toString());
    });
  });
}

describe("worktree admin operations are serialized per repo (#1339)", () => {
  let repo: string;

  beforeEach(async () => {
    const parent = await mkdtemp(join(tmpdir(), "ak-wt-admin-lock-"));
    repo = join(parent, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await writeFile(join(repo, "app.txt"), "marker\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "initial commit"]);
    await git(repo, ["branch", "-M", "main"]);
  });

  it("runs tasks for one repo strictly one at a time, in order, even after a failure", async () => {
    const log: string[] = [];
    const task = (name: string, ms: number, fail = false) => withWorktreeAdminLock(repo, async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      if (fail) throw new Error("boom");
    });
    const results = await Promise.allSettled([task("a", 30, true), task("b", 5), task("c", 1)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("merging/cleaning one workspace while two others are mid-provision leaves theirs registered and intact", async () => {
    await git(repo, ["branch", "feature/ak-1-merged", "main"]);
    const mergedPath = await createWorktree(repo, "feature/ak-1-merged", "main");

    // Provision B and C concurrently with A's post-merge cleanup (remove + prune, repeated).
    const cleanup = (async () => {
      await removeWorktree(repo, mergedPath);
      for (let i = 0; i < 5; i++) await pruneWorktrees(repo);
    })();
    const [pathB, pathC] = await Promise.all([
      createWorktree(repo, "feature/ak-2-b", "main"),
      createWorktree(repo, "feature/ak-3-c", "main"),
      cleanup,
    ]);

    const registered = (await listWorktrees(repo)).map((w) => resolve(w.path).toLowerCase());
    expect(registered).toContain(resolve(pathB).toLowerCase());
    expect(registered).toContain(resolve(pathC).toLowerCase());
    expect(registered).not.toContain(resolve(mergedPath).toLowerCase());
    for (const p of [pathB, pathC]) {
      expect(existsSync(join(p, ".git"))).toBe(true);
      expect(existsSync(join(p, "app.txt"))).toBe(true);
    }
    expect(existsSync(mergedPath)).toBe(false);
    expect((await git(pathB, ["status", "--porcelain"])).trim()).toBe("");
  });
});
