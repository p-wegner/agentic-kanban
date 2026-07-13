// @covers workspaces.multiRepo.mergePrevalidation [git]
//
// Multi-repo merge (full-peers): prevalidateSiblingMerges is ALL-OR-NOTHING — a
// conflicted/dirty sibling throws BEFORE anything merges, so the leading repo can
// never land while a sibling stays behind. executeSiblingMerges lands each
// prevalidated repo sequentially and stamps merged_head_sha; repos 0 commits ahead
// are skipped. Real temp git repos + real test DB.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo, listWorkspaceRepos } from "../repositories/repo.repository.js";
import { prevalidateSiblingMerges, executeSiblingMerges } from "../services/workspace-repos.service.js";
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

async function commitFile(dir: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(dir, file), content);
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", message], dir);
}

let db: TestDb;
let extraRepo: string;
let workspaceId: string;
let projectId: string;
const cleanupDirs: string[] = [];

beforeEach(async () => {
  ({ db } = createTestDb());
  extraRepo = await createTempRepo("kanban-mrm-extra-");
  cleanupDirs.push(extraRepo);

  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/lead", repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/mrm" });
}, 60000);

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    // Remove the whole mkdtemp parent (repo + its .worktrees sibling).
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("multi-repo merge prevalidation + execution", () => {
  it("skips a 0-commits-ahead sibling, merges one with commits, stamps merged_head_sha", async () => {
    // Sibling with commits on the feature branch.
    const worktreePath = await gitService.createWorktree(extraRepo, "feature/mrm", "main");
    await commitFile(worktreePath, "change.txt", "hello\n", "feat: sibling change");
    await insertWorkspaceRepo({
      workspaceId, projectId, path: extraRepo, name: "extra",
      worktreePath, branch: "feature/mrm", baseBranch: "main",
    }, db);

    const plans = await prevalidateSiblingMerges({ gitService, database: db as unknown as Database, workspaceId });
    expect(plans).toHaveLength(1);
    expect(plans[0].uniqueCommits).toBe(1);

    const results = await executeSiblingMerges({
      gitService,
      database: db as unknown as Database,
      createBackup: async () => {},
      workspaceId,
      plans,
    });
    expect(results).toHaveLength(1);
    expect(results[0].merged).toBe(true);
    expect(results[0].mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);

    // The change landed on main in the sibling repo, and the SHA is stamped.
    const log = await exec("git", ["log", "--oneline", "main"], extraRepo);
    expect(log).toContain("sibling change");
    const [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toBe(results[0].mergedHeadSha);
  }, 60000);

  it("returns no plan for a sibling with zero commits ahead", async () => {
    const worktreePath = await gitService.createWorktree(extraRepo, "feature/mrm", "main");
    await insertWorkspaceRepo({
      workspaceId, projectId, path: extraRepo, name: "extra",
      worktreePath, branch: "feature/mrm", baseBranch: "main",
    }, db);
    const plans = await prevalidateSiblingMerges({ gitService, database: db as unknown as Database, workspaceId });
    expect(plans).toEqual([]);
  }, 60000);

  it("throws all-or-nothing when a sibling has conflicts (nothing merged)", async () => {
    const worktreePath = await gitService.createWorktree(extraRepo, "feature/mrm", "main");
    // Conflicting edits to the same file on branch and main.
    await commitFile(worktreePath, "README.md", "# branch version\n", "feat: branch edit");
    await commitFile(extraRepo, "README.md", "# main version\n", "feat: main edit");
    await insertWorkspaceRepo({
      workspaceId, projectId, path: extraRepo, name: "extra",
      worktreePath, branch: "feature/mrm", baseBranch: "main",
    }, db);

    await expect(
      prevalidateSiblingMerges({ gitService, database: db as unknown as Database, workspaceId }),
    ).rejects.toThrow(/Multi-repo merge blocked.*extra/s);

    // Nothing merged: main still has only its own edit.
    const log = await exec("git", ["log", "--oneline", "main"], extraRepo);
    expect(log).not.toContain("branch edit");
  }, 60000);

  it("no-op for a workspace without sibling repos", async () => {
    const plans = await prevalidateSiblingMerges({ gitService, database: db as unknown as Database, workspaceId });
    expect(plans).toEqual([]);
  });
});
