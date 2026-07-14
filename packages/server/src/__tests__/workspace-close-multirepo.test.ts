// @covers workspaces.multiRepo.close [git]
//
// Regression for adversarial finding #4: closeWorkspace ("close WITHOUT merging —
// for work that was abandoned or already merged out-of-band") deliberately preserves
// the LEADING feature branch (it removes only the worktree, never the branch) so
// abandoned work stays recoverable — but it used to call cleanupSiblingWorktrees
// with default opts, which force-deleted (`git branch -D`) every SIBLING branch even
// when it carried unmerged commits, silently destroying half the work of a
// multi-repo workspace. close now passes { preserveUnmerged: true } so sibling
// semantics mirror the leading repo's: an unmerged sibling branch (and its worktree)
// survives; a fully-merged/empty sibling is still cleaned up.
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
import { insertProjectRepo } from "../repositories/repo.repository.js";
import {
  provisionSiblingWorktrees,
  insertSiblingWorktreeRecords,
} from "../services/workspace-repos.service.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";
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
  // Repo nested one level below the mkdtemp dir so its .worktrees sibling stays
  // inside the unique temp dir (see workspace-repos-service.test.ts).
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
let issueId: string;

beforeAll(async () => {
  ({ db } = createTestDb());
  leadRepo = await createTempRepo("kanban-close-multi-lead-");
  extraRepo = await createTempRepo("kanban-close-multi-extra-");

  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: leadRepo, repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });

  await insertProjectRepo({ projectId, path: extraRepo, name: "extra", defaultBranch: "main" }, db);
}, 60000);

afterAll(async () => {
  for (const dir of [leadRepo, extraRepo]) {
    try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A workspace with a real leading worktree + provisioned sibling worktrees. */
async function seedWorkspace(branch: string): Promise<{ id: string; workingDir: string; siblingWt: string }> {
  const workingDir = await gitService.createWorktree(leadRepo, branch, "main");
  const id = randomUUID();
  await db.insert(workspaces).values({ id, issueId, branch, baseBranch: "main", workingDir, status: "active" });
  const siblings = await provisionSiblingWorktrees({
    gitService,
    database: db as unknown as Database,
    projectId,
    branch,
  });
  await insertSiblingWorktreeRecords(id, projectId, siblings, db);
  return { id, workingDir, siblingWt: siblings[0].worktreePath };
}

describe("closeWorkspace multi-repo sibling semantics", () => {
  it("preserves a sibling branch carrying unmerged commits (mirrors the leading repo's branch-preserving close)", async () => {
    const { id, workingDir, siblingWt } = await seedWorkspace("feature/close-keep");

    // Unmerged work committed in the SIBLING repo's worktree.
    await writeFile(join(siblingWt, "work.txt"), "unmerged sibling work\n");
    await exec("git", ["add", "-A"], siblingWt);
    await exec("git", ["commit", "-m", "sibling work"], siblingWt);

    const svc = createWorkspaceCrudService({ database: db as unknown as Database, gitService });
    const result = await svc.closeWorkspace(id);
    expect(result.status).toBe("closed");

    // Leading semantics (pre-existing): worktree removed, branch preserved.
    expect(existsSync(workingDir)).toBe(false);
    expect((await exec("git", ["branch", "--list", "feature/close-keep"], leadRepo)).trim()).not.toBe("");

    // Sibling semantics (the fix): the unmerged branch — and its worktree, kept for
    // fix-up — must survive; before the fix the branch was git branch -D'd.
    expect((await exec("git", ["branch", "--list", "feature/close-keep"], extraRepo)).trim()).not.toBe("");
    expect(existsSync(siblingWt)).toBe(true);
    const ahead = await exec("git", ["rev-list", "--count", "main..feature/close-keep"], extraRepo);
    expect(ahead.trim()).toBe("1");
  }, 60000);

  it("still cleans up a sibling worktree + branch with no unmerged commits on close", async () => {
    const { id, workingDir, siblingWt } = await seedWorkspace("feature/close-clean");

    const svc = createWorkspaceCrudService({ database: db as unknown as Database, gitService });
    await svc.closeWorkspace(id);

    expect(existsSync(workingDir)).toBe(false);
    expect(existsSync(siblingWt)).toBe(false);
    expect((await exec("git", ["branch", "--list", "feature/close-clean"], extraRepo)).trim()).toBe("");
  }, 60000);
});
