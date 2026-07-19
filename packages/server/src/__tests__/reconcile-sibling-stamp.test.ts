// @covers workspaces.multiRepo.reconcileSiblingStamp [git]
//
// Regression for #114: after a fix-and-merge / reconcile-as-done close, the reconciler
// agent has ALREADY merged each sibling's work into its main by hand, so nothing stamps
// `mergedHeadSha` (unlike the executeSiblingMerges pipeline). Without a stamp,
// getRepoMergeStatus (#75) reads every cleaned-up sibling as unmerged — a false negative
// on a fully-landed multi-repo merge ("1/10 merged" though all mains are correct).
//
// stampReconciledSiblingMerges records positive evidence from git ground truth BEFORE the
// sibling branches are force-deleted, so the merged state survives cleanup. Real temp git
// repos + real test DB.

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
import { stampReconciledSiblingMerges } from "../services/workspace-repos.service.js";
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
 * Provision a sibling repo whose feature branch carries `commits` real commits and has
 * ALREADY been merged into main by hand (no --no-ff, so branch is an ancestor of main and
 * 0 commits ahead), mirroring what the reconciler agent leaves behind. Returns the repo
 * path and the base commit the branch was cut from.
 */
async function landedSibling(prefix: string, commits: number): Promise<{ path: string; baseCommitSha: string; worktreePath: string }> {
  const dir = await createTempRepo(prefix);
  const baseCommitSha = await revParse(dir, "main");
  const worktreePath = await gitService.createWorktree(dir, "feature/mrm", "main");
  for (let i = 0; i < commits; i++) {
    await commitFile(worktreePath, `change-${i}.txt`, `hello ${i}\n`, `feat: sibling change ${i}`);
  }
  // The reconciler agent hand-merges the sibling into its main (fast-forward).
  await exec("git", ["merge", "--ff-only", "feature/mrm"], dir);
  return { path: dir, baseCommitSha, worktreePath };
}

let db: TestDb;
let projectId: string;
let issueId: string;
let workspaceId: string;
let leadRepo: string;
const cleanupDirs: string[] = [];

beforeEach(async () => {
  ({ db } = createTestDb());

  // Leading repo is a sibling-only ticket: its feature branch carries NO commits (all the
  // work is in the siblings) — exactly the multirepo-lab cross-cutting scenario in #114.
  leadRepo = await createTempRepo("kanban-rss-lead-");
  cleanupDirs.push(leadRepo);
  const leadBase = await revParse(leadRepo, "main");
  await gitService.createWorktree(leadRepo, "feature/mrm", "main");

  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: leadRepo, repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/mrm", baseBranch: "main",
    baseCommitSha: leadBase, mergedAt: new Date().toISOString(), status: "closed",
  });
}, 60000);

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("stampReconciledSiblingMerges (#114)", () => {
  it("stamps a landed-but-unstamped sibling and is idempotent", async () => {
    const sib = await landedSibling("kanban-rss-sib-", 2);
    cleanupDirs.push(sib.path);
    await insertWorkspaceRepo({
      workspaceId, projectId, path: sib.path, name: "extra",
      worktreePath: join(sib.path, "..", ".worktrees"), branch: "feature/mrm", baseBranch: "main",
      baseCommitSha: sib.baseCommitSha,
    }, db);

    // Before: the row has no mergedHeadSha (the reconciler merged it outside the pipeline).
    let [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toBeFalsy();

    const stamped = await stampReconciledSiblingMerges({ gitService, database: db as unknown as Database, workspaceId });
    expect(stamped).toBe(1);

    [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    // The stamped SHA is the actual landed tip of the sibling's feature branch.
    expect(row.mergedHeadSha).toBe(await revParse(sib.path, "feature/mrm"));

    // Idempotent: a second call sees it already stamped and does nothing.
    const again = await stampReconciledSiblingMerges({ gitService, database: db as unknown as Database, workspaceId });
    expect(again).toBe(0);
  }, 60000);

  it("does NOT stamp an empty (zero-commit) sibling", async () => {
    // Sibling branch exists at main with no unique commits — no merged work to record.
    const dir = await createTempRepo("kanban-rss-empty-");
    cleanupDirs.push(dir);
    const base = await revParse(dir, "main");
    await gitService.createWorktree(dir, "feature/mrm", "main");
    await insertWorkspaceRepo({
      workspaceId, projectId, path: dir, name: "empty",
      worktreePath: join(dir, "..", ".worktrees"), branch: "feature/mrm", baseBranch: "main",
      baseCommitSha: base,
    }, db);

    const stamped = await stampReconciledSiblingMerges({ gitService, database: db as unknown as Database, workspaceId });
    expect(stamped).toBe(0);
    const [row] = await listWorkspaceRepos(workspaceId, db);
    expect(row.mergedHeadSha).toBeFalsy();
  }, 60000);

  it("getRepoMergeStatus reports the sibling merged after stamp — surviving branch cleanup (#75/#114)", async () => {
    const sib = await landedSibling("kanban-rss-status-", 1);
    cleanupDirs.push(sib.path);
    await insertWorkspaceRepo({
      workspaceId, projectId, path: sib.path, name: "extra",
      worktreePath: join(sib.path, "..", ".worktrees"), branch: "feature/mrm", baseBranch: "main",
      baseCommitSha: sib.baseCommitSha,
    }, db);

    await stampReconciledSiblingMerges({ gitService, database: db as unknown as Database, workspaceId });

    // Simulate cleanupSiblingWorktrees removing the worktree + force-deleting the sibling
    // branch after the stamp (the exact state getRepoMergeStatus reads post-reconcile).
    await gitService.removeWorktree(sib.path, sib.worktreePath);
    await exec("git", ["branch", "-D", "feature/mrm"], sib.path);

    const status = await getRepoMergeStatus(workspaceId, { database: db as unknown as Database, gitService });
    const sibling = status.repos.find((r) => r.name === "extra");
    expect(sibling).toBeDefined();
    expect(sibling!.merged).toBe(true);
    expect(sibling!.hasWork).toBe(true);
    expect(sibling!.stranded).toBe(false);
    // Leading is a sibling-only ticket (no leading commits); the whole workspace reads merged.
    expect(status.allMerged).toBe(true);
  }, 60000);
});
