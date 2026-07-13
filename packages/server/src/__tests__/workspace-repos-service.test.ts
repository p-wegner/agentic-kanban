// @covers workspaces.multiRepo.siblingWorktrees [git]
//
// Multi-repo full-peers core loop: provisionSiblingWorktrees creates a worktree on
// the workspace's branch in EVERY additional repo of the project, and
// cleanupSiblingWorktrees removes those worktrees AND their branches (branch
// deletion is mandatory — a stale sibling branch would silently base the next
// workspace on an old commit). Both are strict no-ops for single-repo projects.
// Uses real temp git repos + a real test DB.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertProjectRepo, listWorkspaceRepos } from "../repositories/repo.repository.js";
import {
  provisionSiblingWorktrees,
  insertSiblingWorktreeRecords,
  cleanupSiblingWorktrees,
} from "../services/workspace-repos.service.js";
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
  // Repo nested one level below the mkdtemp dir: worktrees are created at
  // dirname(repoPath)/.worktrees, so nesting keeps them INSIDE the unique temp
  // dir instead of a shared %TEMP%/.worktrees that parallel tests would fight over.
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

let db: TestDb;
let leadRepo: string;
let extraRepo: string;
let projectId: string;
let workspaceId: string;

beforeAll(async () => {
  ({ db } = createTestDb());
  leadRepo = await createTempRepo("kanban-multirepo-lead-");
  extraRepo = await createTempRepo("kanban-multirepo-extra-");

  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: leadRepo, repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/multi" });

  await insertProjectRepo({ projectId, path: extraRepo, name: "extra", defaultBranch: "main" }, db);
}, 60000);

afterAll(async () => {
  for (const dir of [leadRepo, extraRepo]) {
    // Remove the whole mkdtemp parent (repo + its .worktrees sibling).
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("multi-repo sibling worktrees", () => {
  it("provisions a worktree on the same branch in every additional repo, records it, and cleans it up incl. the branch", async () => {
    const siblings = await provisionSiblingWorktrees({
      gitService,
      database: db as unknown as Database,
      projectId,
      branch: "feature/multi",
    });

    expect(siblings).toHaveLength(1);
    const sibling = siblings[0];
    expect(sibling.path).toBe(extraRepo);
    expect(sibling.branch).toBe("feature/multi");
    expect(sibling.baseBranch).toBe("main");
    expect(sibling.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(sibling.worktreePath, "README.md"))).toBe(true);

    await insertSiblingWorktreeRecords(workspaceId, projectId, siblings, db);
    const rows = await listWorkspaceRepos(workspaceId, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].worktreePath).toBe(sibling.worktreePath);

    await cleanupSiblingWorktrees(gitService, workspaceId, db as unknown as Database);
    expect(existsSync(sibling.worktreePath)).toBe(false);
    // Branch must be gone too — stale-branch reuse guard.
    const branches = await exec("git", ["branch", "--list", "feature/multi"], extraRepo);
    expect(branches.trim()).toBe("");
  }, 60000);

  it("rolls back already-provisioned siblings when a later repo fails", async () => {
    // Two additional repos; the second has a defaultBranch that doesn't exist, so
    // provisioning fails AFTER the first sibling's worktree was created. The caller
    // never receives the partial list (the throw prevents the assignment), so the
    // function must remove the first sibling's worktree internally before rethrowing.
    const rollbackProjectId = randomUUID();
    await db.insert(projects).values({ id: rollbackProjectId, name: "rb", repoPath: leadRepo, repoName: "lead" });
    const goodRepo = await createTempRepo("kanban-multirepo-good-");
    const badRepo = await createTempRepo("kanban-multirepo-bad-");
    try {
      await insertProjectRepo({ projectId: rollbackProjectId, path: goodRepo, name: "good", defaultBranch: "main" }, db);
      await insertProjectRepo({ projectId: rollbackProjectId, path: badRepo, name: "bad", defaultBranch: "does-not-exist" }, db);

      await expect(provisionSiblingWorktrees({
        gitService,
        database: db as unknown as Database,
        projectId: rollbackProjectId,
        branch: "feature/rollback",
      })).rejects.toThrow();

      // The good repo's sibling worktree must be gone again — only the main checkout remains.
      const worktrees = await exec("git", ["worktree", "list", "--porcelain"], goodRepo);
      const count = worktrees.split("\n").filter((l) => l.startsWith("worktree ")).length;
      expect(count).toBe(1);
    } finally {
      for (const dir of [goodRepo, badRepo]) {
        try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }, 60000);

  it("is a no-op for a project with no additional repos", async () => {
    const otherProjectId = randomUUID();
    await db.insert(projects).values({ id: otherProjectId, name: "solo", repoPath: leadRepo, repoName: "lead" });
    const siblings = await provisionSiblingWorktrees({
      gitService,
      database: db as unknown as Database,
      projectId: otherProjectId,
      branch: "feature/solo",
    });
    expect(siblings).toEqual([]);
  }, 30000);
});
