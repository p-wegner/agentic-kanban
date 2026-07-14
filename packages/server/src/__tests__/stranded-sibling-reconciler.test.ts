// @covers workspaces.multiRepo.strandedSiblingReconciler [git]
//
// Startup reconciler for the multi-repo crash gap (review finding #18): the merge
// pipeline stamps mergedAt + closes the workspace BEFORE the sibling merges run, so a
// crash in that window strands sibling repos unmerged with the issue marked Done — and
// no other startup task sees them. reconcileStrandedSiblingMerges detects the persisted
// progress state (repos rows with mergedHeadSha NULL on a mergedAt-stamped workspace),
// git-verifies the strand, lands it via the guarded sibling pipeline, and records
// everything on the issue. Real temp git repos + real test DB.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, workspaces, issues, projectStatuses, issueComments } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo, listWorkspaceRepos, setWorkspaceRepoMergedSha } from "../repositories/repo.repository.js";
import { reconcileStrandedSiblingMerges } from "../startup/merge-workflow.js";
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

const BRANCH = "feature/strand";

let db: TestDb;
let siblingRepo: string;
let projectId: string;
let issueId: string;
let workspaceId: string;
const cleanupDirs: string[] = [];

beforeEach(async () => {
  ({ db } = createTestDb());
  siblingRepo = await createTempRepo("kanban-strand-sib-");
  cleanupDirs.push(siblingRepo);

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/lead", repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Done", sortOrder: 3, createdAt: now });
  issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 180 });
  workspaceId = randomUUID();
  // The crash aftermath: leading merged (mergedAt stamped), workspace closed, workingDir nulled.
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: BRANCH, workingDir: null, baseBranch: "main",
    status: "closed", mergedAt: now, closedAt: now,
  });
}, 60000);

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function insertStrandedSibling(): Promise<string> {
  const worktreePath = await gitService.createWorktree(siblingRepo, BRANCH, "main");
  await commitFile(worktreePath, "change.txt", "stranded work\n", "feat: stranded sibling change");
  await insertWorkspaceRepo({
    workspaceId, projectId, path: siblingRepo, name: "sibling",
    worktreePath, branch: BRANCH, baseBranch: "main",
  }, db);
  return worktreePath;
}

async function commentsForIssue(): Promise<{ body: string }[]> {
  return db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
}

describe("reconcileStrandedSiblingMerges (#18)", () => {
  it("lands a stranded sibling merge, stamps the row, cleans up, and records it on the issue", async () => {
    await insertStrandedSibling();

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 1, preserved: 0 });

    // The stranded work landed on the sibling's base branch.
    const log = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(log).toContain("stranded sibling change");

    // Progress state stamped, and the now-merged sibling branch/worktree cleaned.
    const [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    const branches = await exec("git", ["branch", "--list", BRANCH], siblingRepo);
    expect(branches.trim()).toBe("");

    // Loud on the issue timeline.
    const comments = await commentsForIssue();
    expect(comments.some((c) => /landed 1 sibling repo merge/i.test(c.body))).toBe(true);

    // Idempotent: a second run finds nothing pending.
    const second = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(second).toEqual({ landed: 0, preserved: 0 });
  }, 90000);

  it("preserves the sibling branch and records the blocker when the strand cannot land (conflict)", async () => {
    const worktreePath = await insertStrandedSibling();
    // Conflicting edits on the sibling branch vs its main.
    await commitFile(worktreePath, "README.md", "# branch version\n", "feat: branch edit");
    await commitFile(siblingRepo, "README.md", "# main version\n", "feat: main edit");

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 0, preserved: 1 });

    // Nothing destroyed.
    const branches = await exec("git", ["branch", "--list", BRANCH], siblingRepo);
    expect(branches.trim()).not.toBe("");
    const mainLog = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(mainLog).not.toContain("branch edit");

    // The gap is DETECTABLE: recorded loudly on the issue.
    const comments = await commentsForIssue();
    expect(comments.some((c) => /Multi-repo merge INCOMPLETE/.test(c.body))).toBe(true);
  }, 90000);

  it("is a no-op when the sibling merge already landed (mergedHeadSha stamped)", async () => {
    await insertStrandedSibling();
    const [row] = await listWorkspaceRepos(workspaceId, db);
    await setWorkspaceRepoMergedSha(row.id, "0000000000000000000000000000000000000000", db);

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 0, preserved: 0 });
    expect(await commentsForIssue()).toEqual([]);
  }, 60000);

  it("is a no-op for a sibling row with no commits ahead (not a strand)", async () => {
    const worktreePath = await gitService.createWorktree(siblingRepo, BRANCH, "main");
    await insertWorkspaceRepo({
      workspaceId, projectId, path: siblingRepo, name: "sibling",
      worktreePath, branch: BRANCH, baseBranch: "main",
    }, db);

    const result = await reconcileStrandedSiblingMerges(db as unknown as Database);
    expect(result).toEqual({ landed: 0, preserved: 0 });
    expect(await commentsForIssue()).toEqual([]);
  }, 60000);
});
