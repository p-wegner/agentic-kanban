// @covers workspaces.multiRepo.reconcileLeadingStamp [git]
//
// Regression for #115 (mirror of #114): after a fix-and-merge / reconcile-as-done close, the
// reconciler agent has ALREADY merged the LEADING branch into base by hand, and closeWorkspace
// stamps `mergedAt` but never `mergedHeadSha`. Without the stamp, once the leading feature branch
// is cleaned up, getRepoMergeStatus (#75) falls back to the (null) workspace `mergedHeadSha` for
// the historic tip and reads the leading repo as `hasWork:false / merged:false` — a false negative
// on a fully-landed multi-repo merge (observed in multirepo-lab rounds 10/11/13).
//
// stampReconciledLeadingMerge records positive evidence from git ground truth BEFORE the leading
// branch is force-deleted, so the merged state survives cleanup. Real temp git repos + real test DB.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { stampReconciledLeadingMerge } from "../services/workspace-repos.service.js";
import { getRepoMergeStatus } from "../services/repo-merge-status.service.js";
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

async function revParse(dir: string, ref: string): Promise<string> {
  return (await exec("git", ["rev-parse", ref], dir)).trim();
}

/**
 * Provision a LEADING repo whose feature branch carries `commits` real commits and has ALREADY
 * been merged into main by hand (fast-forward, so branch is an ancestor of main and 0 commits
 * ahead), mirroring what the reconciler agent leaves behind on the leading repo. Returns the repo
 * path, the base commit the branch was cut from, and the worktree path.
 */
async function landedLeading(prefix: string, commits: number): Promise<{ path: string; baseCommitSha: string; worktreePath: string }> {
  const dir = await createTempRepo(prefix);
  const baseCommitSha = await revParse(dir, "main");
  const worktreePath = await gitService.createWorktree(dir, "feature/mrm", "main");
  for (let i = 0; i < commits; i++) {
    await commitFile(worktreePath, `lead-${i}.txt`, `hello ${i}\n`, `feat: leading change ${i}`);
  }
  await exec("git", ["merge", "--ff-only", "feature/mrm"], dir);
  return { path: dir, baseCommitSha, worktreePath };
}

let db: TestDb;
let projectId: string;
let issueId: string;
let workspaceId: string;
const cleanupDirs: string[] = [];

async function seedWorkspace(leadRepo: string, baseCommitSha: string) {
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: leadRepo, repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/mrm", baseBranch: "main",
    baseCommitSha, mergedAt: new Date().toISOString(), status: "closed",
  });
}

beforeEach(async () => {
  ({ db } = createTestDb());
}, 60000);

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("stampReconciledLeadingMerge (#115)", () => {
  it("stamps a landed-but-unstamped leading repo and is idempotent, preserving mergedAt", async () => {
    const lead = await landedLeading("kanban-lead-stamp-", 2);
    cleanupDirs.push(lead.path);
    await seedWorkspace(lead.path, lead.baseCommitSha);
    const before = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(before.mergedHeadSha).toBeFalsy();
    const mergedAtBefore = before.mergedAt;

    const stamped = await stampReconciledLeadingMerge({ gitService, database: db as unknown as Database, workspaceId });
    expect(stamped).toBe(true);

    const after = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(after.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    // The stamped SHA is the actual landed tip of the leading feature branch.
    expect(after.mergedHeadSha).toBe(await revParse(lead.path, "feature/mrm"));
    // mergedAt is left untouched (the close path owns it).
    expect(after.mergedAt).toBe(mergedAtBefore);

    // Idempotent: a second call sees it already stamped and does nothing.
    const again = await stampReconciledLeadingMerge({ gitService, database: db as unknown as Database, workspaceId });
    expect(again).toBe(false);
  }, 60000);

  it("does NOT stamp a sibling-only leading repo (zero leading commits)", async () => {
    // Leading feature branch exists at main with no unique commits — all the work is in siblings.
    const dir = await createTempRepo("kanban-lead-empty-");
    cleanupDirs.push(dir);
    const base = await revParse(dir, "main");
    await gitService.createWorktree(dir, "feature/mrm", "main");
    await seedWorkspace(dir, base);

    const stamped = await stampReconciledLeadingMerge({ gitService, database: db as unknown as Database, workspaceId });
    expect(stamped).toBe(false);
    const row = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(row.mergedHeadSha).toBeFalsy();
  }, 60000);

  it("getRepoMergeStatus reports the leading repo merged after stamp — surviving branch cleanup (#75/#115)", async () => {
    const lead = await landedLeading("kanban-lead-status-", 1);
    cleanupDirs.push(lead.path);
    await seedWorkspace(lead.path, lead.baseCommitSha);

    await stampReconciledLeadingMerge({ gitService, database: db as unknown as Database, workspaceId });

    // Simulate cleanup removing the worktree + force-deleting the leading feature branch after the
    // stamp (the exact state getRepoMergeStatus reads post-reconcile).
    await gitService.removeWorktree(lead.path, lead.worktreePath);
    await exec("git", ["branch", "-D", "feature/mrm"], lead.path);

    const status = await getRepoMergeStatus(workspaceId, { database: db as unknown as Database, gitService });
    const leading = status.repos.find((r) => r.isLeading);
    expect(leading).toBeDefined();
    expect(leading!.merged).toBe(true);
    expect(leading!.hasWork).toBe(true);
    expect(leading!.stranded).toBe(false);
    // No siblings on this workspace, so the whole workspace reads merged.
    expect(status.allMerged).toBe(true);
  }, 60000);
});
