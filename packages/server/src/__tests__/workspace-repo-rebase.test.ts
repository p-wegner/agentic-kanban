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

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

async function createTempRepo(prefix: string): Promise<string> {
  // Repo nested one level below the mkdtemp dir so its .worktrees sibling stays inside
  // the unique temp dir instead of a shared %TEMP%/.worktrees parallel tests fight over.
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const dir = join(parent, "repo");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  await exec("git", ["init"], dir);
  await exec("git", ["config", "user.email", "test@test.com"], dir);
  await exec("git", ["config", "user.name", "Test"], dir);
  await writeFile(join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  await exec("git", ["branch", "-M", "main"], dir);
  return dir;
}

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
  }, 60000);

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
  }, 60000);

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
  }, 60000);
});
