// Regression test (#29): a branch named '..' or '.' survives safeName sanitization
// ('.', '-', '_' are allowed chars), so worktreePath = join(parent, '.worktrees', '..')
// resolves to the repo's PARENT directory — which the leftover-directory cleanup in
// createWorktree can then recursively delete, before git ever validates the branch
// name. createWorktree must reject a branch whose sanitized leaf is '', '.', or '..'
// outright, rather than ever computing such a worktreePath.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "../src/lib/git-service.js";

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

async function initRepoAt(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.local"]);
  await git(dir, ["config", "user.name", "Worktree Escape Test"]);
  await writeFile(join(dir, `${name}.txt`), `marker for ${name}\n`);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "initial commit"]);
  await git(dir, ["branch", "-M", "main"]);
  return dir;
}

describe("createWorktree rejects branch names that sanitize to a path-escaping leaf", () => {
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "ak-wt-escape-"));
    repo = await initRepoAt(parent, "app");
  }, GIT_IO_TIMEOUT_MS);

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("rejects a branch named '..' instead of resolving the worktree into the repo's parent directory", async () => {
    await expect(createWorktree(repo, "..", "main")).rejects.toThrow();
  }, GIT_IO_TIMEOUT_MS);

  it("rejects a branch named '.' instead of resolving the worktree onto the .worktrees dir itself", async () => {
    await expect(createWorktree(repo, ".", "main")).rejects.toThrow();
  }, GIT_IO_TIMEOUT_MS);

  it("rejects an empty branch name (sanitizes to an empty leaf)", async () => {
    await expect(createWorktree(repo, "", "main")).rejects.toThrow();
  }, GIT_IO_TIMEOUT_MS);

  it("still creates a normal worktree for an unaffected branch name", async () => {
    const wt = await createWorktree(repo, "feature/normal", "main");
    expect(wt).toContain("feature_normal");
  }, GIT_IO_TIMEOUT_MS);
});
