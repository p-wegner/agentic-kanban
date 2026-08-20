// @covers workspaces.multiRepo.perRepoRebase [git]
//
// Per-repo recovery for a stranded sibling (#93): rebaseRepo rebases ONE repo's worktree
// branch onto its base — a sibling by name, or the leading repo via LEADING_REPO_KEY —
// without landing anything (the coordinated all-or-nothing merge invariant is untouched).
// Clean rebase reports success; a conflict aborts the in-progress rebase (worktree left
// clean) and reports the conflicting files. Uses real temp git repos + a real test DB.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { LEADING_REPO_KEY } from "@agentic-kanban/shared";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertProjectRepo } from "../repositories/repo.repository.js";
import { provisionSiblingWorktrees, insertSiblingWorktreeRecords } from "../services/workspace-repos.service.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import type { Database } from "../db/index.js";

/**
 * Committer identity for every git call in this suite, supplied by ENV rather than by two
 * `git config` calls per repo. Env costs no process launches, and unlike repo-local config it
 * also covers commits made inside the WORKTREES (which is where most of this suite's commits
 * happen) without relying on them inheriting anything.
 */
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...GIT_IDENTITY_ENV } }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

/**
 * Every `git` invocation here costs whatever a process launch costs on the host, and on a
 * Windows box with real-time AV scanning an unsigned `git.exe` that is ~2 s — measured on the
 * dev machine this suite was failing on: `git --version`, which does no work at all, took
 * 0.75-3.3 s while `cmd /c exit` took 0.2 s. At seven spawns per repo and two repos, repo
 * creation alone was ~28 s of the ~67 s setup, which is why all three tests hit their 60 s
 * timeout without ever reaching the code under test (#284).
 *
 * So: three spawns instead of seven. `init -b main` replaces the trailing `branch -M`, and
 * {@link GIT_IDENTITY_ENV} replaces the two `config` calls. Same repo, same starting state,
 * less than half the process launches — and faster everywhere, not only on a slow host.
 */
async function createTempRepo(prefix: string): Promise<string> {
  // Repo nested one level below the mkdtemp dir so its .worktrees sibling stays inside
  // the unique temp dir instead of a shared %TEMP%/.worktrees parallel tests fight over.
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const dir = join(parent, "repo");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  await exec("git", ["init", "-b", "main"], dir);
  await writeFile(join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  return dir;
}

/**
 * Per-test budget. The work itself is small; what it buys is headroom for ~30 git process
 * launches on a host where each one can cost seconds (see {@link createTempRepo}). A tighter
 * number does not make the suite faster, it makes it red on the machines that most need it
 * to be honest.
 */
const REAL_GIT_TEST_TIMEOUT_MS = 180_000;

interface Setup {
  db: TestDb;
  mergeService: ReturnType<typeof createWorkspaceMergeService>;
  leadRepo: string;
  extraRepo: string;
  workspaceId: string;
  leadingWorktree: string;
  siblingWorktree: string;
}

const cleanups: string[] = [];

async function setupWorkspaceWithSibling(): Promise<Setup> {
  const { db } = createTestDb();
  const leadRepo = await createTempRepo("kanban-rebase-lead-");
  const extraRepo = await createTempRepo("kanban-rebase-extra-");
  cleanups.push(join(leadRepo, ".."), join(extraRepo, ".."));

  const branch = "feature/rebase";
  const projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: leadRepo, repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  await insertProjectRepo({ projectId, path: extraRepo, name: "extra", defaultBranch: "main" }, db);

  // Leading worktree — the workspace's own workingDir (required so rebaseRepo doesn't
  // treat the workspace as direct).
  const leadingWorktree = await gitService.createWorktree(leadRepo, branch, "main");
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch, workingDir: leadingWorktree, baseBranch: "main", status: "active" });

  const siblings = await provisionSiblingWorktrees({ gitService, database: db as unknown as Database, projectId, branch });
  await insertSiblingWorktreeRecords(workspaceId, projectId, siblings, db);

  const mergeService = createWorkspaceMergeService({
    database: db as unknown as Database,
    gitService,
    createBackup: async () => ({}),
    processKiller: async () => 0,
  });

  return { db, mergeService, leadRepo, extraRepo, workspaceId, leadingWorktree, siblingWorktree: siblings[0].worktreePath };
}

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()!;
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("per-repo rebase (#93)", () => {
  it("rebases a stranded sibling cleanly onto its advanced base and reports success", async () => {
    const { mergeService, extraRepo, workspaceId, siblingWorktree } = await setupWorkspaceWithSibling();

    // Sibling has its own commit on the feature branch (a NEW file, so it won't conflict).
    await writeFile(join(siblingWorktree, "sibling.txt"), "sibling work\n");
    await exec("git", ["add", "."], siblingWorktree);
    await exec("git", ["commit", "-m", "sibling work"], siblingWorktree);

    // Base (main) advances with a non-conflicting commit — the sibling is now behind base.
    await writeFile(join(extraRepo, "base.txt"), "base advanced\n");
    await exec("git", ["add", "."], extraRepo);
    await exec("git", ["commit", "-m", "advance base"], extraRepo);

    const result = await mergeService.rebaseRepo(workspaceId, "extra");

    expect(result).toMatchObject({ repo: "extra", success: true });
    expect(result.conflictingFiles ?? []).toEqual([]);
    // The base's new commit is now in the sibling worktree (rebased on top), and the
    // sibling's own work is preserved.
    expect(existsSync(join(siblingWorktree, "base.txt"))).toBe(true);
    expect(existsSync(join(siblingWorktree, "sibling.txt"))).toBe(true);
    // Rebase-only: nothing landed on the sibling's base — it still lacks the feature file.
    expect(existsSync(join(extraRepo, "sibling.txt"))).toBe(false);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("aborts on conflict, leaving the sibling worktree clean, and reports the conflicting files", async () => {
    const { mergeService, extraRepo, workspaceId, siblingWorktree } = await setupWorkspaceWithSibling();

    // Both the feature branch and the base edit README.md at the same spot → conflict.
    await writeFile(join(siblingWorktree, "README.md"), "FEATURE\n");
    await exec("git", ["add", "."], siblingWorktree);
    await exec("git", ["commit", "-m", "feature edit"], siblingWorktree);

    await writeFile(join(extraRepo, "README.md"), "BASE\n");
    await exec("git", ["add", "."], extraRepo);
    await exec("git", ["commit", "-m", "base edit"], extraRepo);

    const result = await mergeService.rebaseRepo(workspaceId, "extra");

    expect(result.repo).toBe("extra");
    expect(result.success).toBe(false);
    expect(result.conflictingFiles).toContain("README.md");
    // The conflicted rebase was aborted — the worktree is clean (no rebase in progress)
    // and the feature content is intact, so the sibling can be recovered another way.
    expect(await gitService.isRebaseInProgress(siblingWorktree)).toBe(false);
    const readme = await exec("git", ["show", "HEAD:README.md"], siblingWorktree);
    expect(readme.trim()).toBe("FEATURE");
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it("rebases the leading repo via LEADING_REPO_KEY", async () => {
    const { mergeService, leadRepo, workspaceId, leadingWorktree } = await setupWorkspaceWithSibling();

    await writeFile(join(leadingWorktree, "lead.txt"), "lead work\n");
    await exec("git", ["add", "."], leadingWorktree);
    await exec("git", ["commit", "-m", "lead work"], leadingWorktree);

    await writeFile(join(leadRepo, "base.txt"), "base advanced\n");
    await exec("git", ["add", "."], leadRepo);
    await exec("git", ["commit", "-m", "advance base"], leadRepo);

    const result = await mergeService.rebaseRepo(workspaceId, LEADING_REPO_KEY);

    expect(result).toMatchObject({ repo: "leading", success: true });
    expect(existsSync(join(leadingWorktree, "base.txt"))).toBe(true);
    expect(existsSync(join(leadingWorktree, "lead.txt"))).toBe(true);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});
