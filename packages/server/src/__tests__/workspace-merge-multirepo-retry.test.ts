// @covers workspaces.multiRepo.mergeRetry [git]
//
// Multi-repo merge retry + recovery (review findings #2 / #18 / #3):
//  - A merge retry on a workspace already marked merged (partial multi-repo merge:
//    leading landed, sibling stranded by a crash or post-prevalidation failure) must
//    LAND the pending sibling merges — not force-delete the preserved sibling branch
//    (the pre-fix behavior destroyed the only ref to the unmerged work).
//  - When the pending sibling cannot land cleanly (conflicts), the retry must refuse
//    and preserve everything.
//  - A sibling-only workspace (leading branch = fresh 0-commit cut) must merge through
//    the normal pipeline instead of short-circuiting to "false-positive guard".
// Real temp git repos + real test DB.

// vi.mock must come before imports — vitest hoists these to the top of the module.
// Post-merge cleanup (sibling-only proceed path) must not run the real handoff-draft /
// shared-rebuild / learning-step machinery against the throwaway temp repos.
vi.mock("../services/github-handoff-draft.service.js", () => ({
  generateAndPersistGithubHandoffDraft: vi.fn(async () => ({ artifactId: "test-id", content: "test" })),
}));
vi.mock("../services/merge-helpers.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/merge-helpers.service.js")>();
  return {
    ...actual,
    rebuildSharedIfChanged: vi.fn(async () => {}),
    runLearningStep: vi.fn(async () => {}),
  };
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo, listWorkspaceRepos } from "../repositories/repo.repository.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { activeMerges } from "../services/workspace-internals.js";
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
  // dirname(repoPath)/.worktrees, so nesting keeps them INSIDE the unique temp dir.
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

const BRANCH = "feature/mrr";

let db: TestDb;
let leadRepo: string;
let siblingRepo: string;
let projectId: string;
let issueId: string;
let workspaceId: string;
const cleanupDirs: string[] = [];

beforeEach(async () => {
  ({ db } = createTestDb());
  leadRepo = await createTempRepo("kanban-mrr-lead-");
  siblingRepo = await createTempRepo("kanban-mrr-sib-");
  cleanupDirs.push(leadRepo, siblingRepo);

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: leadRepo, repoName: "lead", defaultBranch: "main" });
  const todoStatusId = randomUUID();
  const doneStatusId = randomUUID();
  await db.insert(projectStatuses).values([
    { id: todoStatusId, projectId, name: "Todo", sortOrder: 0, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, createdAt: now },
  ]);
  issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId: todoStatusId, title: "t", issueNumber: 18 });
  workspaceId = randomUUID();
}, 60000);

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    // Remove the whole mkdtemp parent (repo + its .worktrees sibling).
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeService() {
  return createWorkspaceMergeService({
    database: db as unknown as Database,
    gitService,
    createBackup: async () => {},
    processKiller: async () => 0,
  });
}

async function insertSiblingWithCommit(): Promise<string> {
  const worktreePath = await gitService.createWorktree(siblingRepo, BRANCH, "main");
  await commitFile(worktreePath, "change.txt", "sibling work\n", "feat: stranded sibling change");
  await insertWorkspaceRepo({
    workspaceId, projectId, path: siblingRepo, name: "sibling",
    worktreePath, branch: BRANCH, baseBranch: "main",
  }, db);
  return worktreePath;
}

async function issueStatusName(): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

describe("multi-repo merge retry after a partial merge (#2/#18)", () => {
  it("lands the stranded sibling merge instead of destroying the preserved branch", async () => {
    // Partial-merge aftermath: leading merged + branch deleted, workspace closed with
    // mergedAt stamped, sibling row unstamped with real unmerged commits.
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: BRANCH, workingDir: null, baseBranch: "main",
      status: "closed", mergedAt: now, closedAt: now, readyForMerge: false,
    });
    await insertSiblingWithCommit();

    const svc = makeService();
    const result = await svc.mergeWorkspace(workspaceId) as { mergeOutput: string };
    expect(result.mergeOutput).toMatch(/already marked as merged/i);
    expect(result.mergeOutput).toMatch(/Landed 1 pending sibling/i);

    // The stranded work is now ON the sibling's base branch — not force-deleted.
    const log = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(log).toContain("stranded sibling change");

    // The repos row is stamped, and the (now merged) sibling branch/worktree are cleaned.
    const [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    const branches = await exec("git", ["branch", "--list", BRANCH], siblingRepo);
    expect(branches.trim()).toBe("");

    // Issue converged to Done.
    expect(await issueStatusName()).toBe("Done");
  }, 90000);

  it("refuses the retry and preserves the sibling branch when it cannot land (conflict)", async () => {
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: BRANCH, workingDir: null, baseBranch: "main",
      status: "closed", mergedAt: now, closedAt: now, readyForMerge: false,
    });
    const worktreePath = await insertSiblingWithCommit();
    // Conflicting edits: same file changed on the sibling branch and on its main.
    await commitFile(worktreePath, "README.md", "# branch version\n", "feat: branch edit");
    await commitFile(siblingRepo, "README.md", "# main version\n", "feat: main edit");

    const svc = makeService();
    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "sibling_merge_pending" },
    });

    // Nothing destroyed: branch + its unmerged commits + worktree all survive.
    const branches = await exec("git", ["branch", "--list", BRANCH], siblingRepo);
    expect(branches.trim()).not.toBe("");
    const branchLog = await exec("git", ["log", "--oneline", BRANCH], siblingRepo);
    expect(branchLog).toContain("branch edit");
    const mainLog = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(mainLog).not.toContain("branch edit");
    expect(existsSync(worktreePath)).toBe(true);
  }, 90000);
});

describe("sibling-only workspace merges through the normal pipeline (#3)", () => {
  it("lands the sibling work when the leading branch is a fresh 0-commit cut", async () => {
    // Leading branch exists but has no unique commits — pre-fix this short-circuited
    // to clean-ancestor ("Merge skipped as a false-positive guard") forever.
    await exec("git", ["branch", BRANCH], leadRepo);
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: BRANCH, workingDir: null, baseBranch: "main",
      status: "idle", readyForMerge: true,
    });
    await insertSiblingWithCommit();

    const svc = makeService();
    const result = await svc.mergeWorkspace(workspaceId) as { merged?: boolean; mergeOutput: string };
    expect(result.merged).toBe(true);
    expect(result.mergeOutput).not.toMatch(/false-positive/i);

    const log = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(log).toContain("stranded sibling change");
    const [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await issueStatusName()).toBe("Done");

    // Let the deferred post-merge cleanup (held under the repo merge lock) drain
    // before the temp repos are removed.
    await vi.waitFor(() => {
      expect(activeMerges.size).toBe(0);
    }, { timeout: 30000 });
  }, 120000);
});
