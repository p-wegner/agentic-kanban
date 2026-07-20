// @covers git-integration.rebase.detect-in-progress-worktree [regression]
//
// #147: isRebaseInProgress joined an absolute --git-dir onto worktreePath with path.join,
// which does NOT reset on an absolute segment (that's path.resolve) — in a LINKED WORKTREE
// `git rev-parse --git-dir` returns an absolute path, so the joined probe path was garbage
// and the function always returned false. Every prior test either mocked this function or
// asserted it from the MAIN checkout (where --git-dir returns the relative ".git", so the
// join happened to work). This test starts a REAL conflicting rebase in a linked worktree —
// the one case no existing test covered — and asserts the predicate actually sees it.

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

async function createTempRepo(): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kanban-rebase-inprogress-"));
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

describe("isRebaseInProgress in a linked worktree (#147)", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length) {
      const p = cleanups.pop()!;
      try { await rm(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("is false before a rebase, true once a real conflicting rebase is left in progress, false after --abort", async () => {
    const { dir: repo, base } = await createTempRepo();
    cleanups.push(repo);

    // Linked worktree — `git rev-parse --git-dir` here returns an ABSOLUTE path
    // (.../.git/worktrees/<name>), which is the exact case the buggy path.join mishandled.
    const wt = await gitService.createWorktree(repo, "feature/rebase-in-progress", base);
    cleanups.push(wt);

    expect(await gitService.isRebaseInProgress(wt)).toBe(false);

    // Both sides edit foo.txt divergently -> rebase MUST conflict and stop mid-rebase.
    await commitFile(repo, "foo.txt", "base advanced\n", "chore: base edits foo");
    await commitFile(wt, "foo.txt", "feature edits the same line\n", "feat: feature edits foo");

    await expect(exec("git", ["rebase", base], wt)).rejects.toThrow();

    expect(await gitService.isRebaseInProgress(wt)).toBe(true);

    await exec("git", ["rebase", "--abort"], wt);

    expect(await gitService.isRebaseInProgress(wt)).toBe(false);
  }, 40000);
});
