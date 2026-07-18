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
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import * as gitService from "../services/git.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertProjectRepo, listWorkspaceRepos } from "../repositories/repo.repository.js";
import {
  provisionSiblingWorktrees,
  insertSiblingWorktreeRecords,
  cleanupSiblingWorktrees,
  resolveScopedSiblingRepos,
} from "../services/workspace-repos.service.js";
import type { RepoRow } from "../repositories/repo.repository.js";
import type { Database } from "../db/index.js";

function repo(partial: Partial<RepoRow> & { id: string; path: string }): RepoRow {
  return { name: null, ...partial } as unknown as RepoRow;
}

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

/** Init a git repo at parentDir/<name> with a marker file named after the repo. */
async function initRepoIn(parentDir: string, name: string): Promise<string> {
  const dir = join(parentDir, name);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  await exec("git", ["init"], dir);
  await exec("git", ["config", "user.email", "test@test.com"], dir);
  await exec("git", ["config", "user.name", "Test"], dir);
  await writeFile(join(dir, `${name}.txt`), `marker for ${name}\n`);
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  await exec("git", ["branch", "-M", "main"], dir);
  return dir;
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
let issueId: string;
let workspaceId: string;

beforeAll(async () => {
  ({ db } = createTestDb());
  leadRepo = await createTempRepo("kanban-multirepo-lead-");
  extraRepo = await createTempRepo("kanban-multirepo-extra-");

  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: leadRepo, repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  issueId = randomUUID();
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

describe("resolveScopedSiblingRepos (per-repo scope, #91)", () => {
  const repos: RepoRow[] = [
    repo({ id: "id-a", name: "alpha", path: "/repos/alpha" }),
    repo({ id: "id-b", name: "beta", path: "/repos/beta" }),
    repo({ id: "id-c", name: null, path: "/repos/gamma" }),
  ];

  it("returns ALL repos when scope is omitted (undefined)", () => {
    expect(resolveScopedSiblingRepos(repos, undefined)).toEqual(repos);
  });

  it("returns ALL repos when scope is empty (safety default)", () => {
    expect(resolveScopedSiblingRepos(repos, [])).toEqual(repos);
  });

  it("narrows to the selected subset by id", () => {
    const out = resolveScopedSiblingRepos(repos, ["id-a", "id-c"]);
    expect(out.map((r) => r.id)).toEqual(["id-a", "id-c"]);
  });

  it("matches by name and by path basename too", () => {
    expect(resolveScopedSiblingRepos(repos, ["beta"]).map((r) => r.id)).toEqual(["id-b"]);
    expect(resolveScopedSiblingRepos(repos, ["gamma"]).map((r) => r.id)).toEqual(["id-c"]);
  });

  it("is case-insensitive and ignores the leading sentinel", () => {
    // A deselect-all-siblings choice arrives as just the leading sentinel — NON-empty,
    // so it is NOT the empty="all" default: it must yield the empty set (leading-only).
    expect(resolveScopedSiblingRepos(repos, ["__leading__"])).toEqual([]);
    expect(resolveScopedSiblingRepos(repos, ["__leading__", "ALPHA"]).map((r) => r.id)).toEqual(["id-a"]);
  });
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

  it("honors repoScope: a deselected sibling gets NO worktree; a selected one does (#91)", async () => {
    // Deselect the only sibling (scope = leading sentinel only) → nothing provisioned.
    const none = await provisionSiblingWorktrees({
      gitService,
      database: db as unknown as Database,
      projectId,
      branch: "feature/scope-none",
      repoScope: ["__leading__"],
    });
    expect(none).toEqual([]);
    // No branch was created in the sibling repo.
    expect((await exec("git", ["branch", "--list", "feature/scope-none"], extraRepo)).trim()).toBe("");

    // Select the sibling by name → it IS provisioned.
    const some = await provisionSiblingWorktrees({
      gitService,
      database: db as unknown as Database,
      projectId,
      branch: "feature/scope-some",
      repoScope: ["__leading__", "extra"],
    });
    expect(some).toHaveLength(1);
    expect(some[0].path).toBe(extraRepo);
    expect(existsSync(join(some[0].worktreePath, "README.md"))).toBe(true);

    // Cleanup the provisioned worktree + branch directly (no DB rows written for it).
    await gitService.removeWorktree(extraRepo, some[0].worktreePath);
    await gitService.deleteBranch(extraRepo, "feature/scope-some", { force: true });
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

  it("does not destroy the leading worktree when the additional repo shares its parent directory", async () => {
    // Regression (adversarial finding #1): every worktree lands at
    // dirname(repoPath)/.worktrees/<sanitized-branch>, and multi-repo workspaces use
    // the SAME branch in every repo — so repos sharing ONE parent directory (the
    // guaranteed layout for clone-from-URL repos, which all land in getReposRoot())
    // computed the identical path, and the sibling fan-out rm -rf'd the just-created
    // leading worktree and checked the sibling out in its place. The other tests in
    // this file nest each repo under a unique mkdtemp parent, which is exactly why
    // this collision was never caught — so this test shares ONE parent.
    const parent = await mkdtemp(join(tmpdir(), "kanban-multirepo-sharedparent-"));
    try {
      const lead = await initRepoIn(parent, "app");
      const extra = await initRepoIn(parent, "lib");
      const sharedProjectId = randomUUID();
      await db.insert(projects).values({ id: sharedProjectId, name: "sp", repoPath: lead, repoName: "app", defaultBranch: "main" });
      await insertProjectRepo({ projectId: sharedProjectId, path: extra, name: "lib", defaultBranch: "main" }, db);

      // The leading worktree, exactly as workspace-provision creates it.
      const leadingWt = await gitService.createWorktree(lead, "feature/shared-parent", "main");
      expect(existsSync(join(leadingWt, "app.txt"))).toBe(true);

      const siblings = await provisionSiblingWorktrees({
        gitService,
        database: db as unknown as Database,
        projectId: sharedProjectId,
        branch: "feature/shared-parent",
      });

      expect(siblings).toHaveLength(1);
      // The sibling landed elsewhere (namespaced by repo dir name), and the leading
      // worktree is still the LEAD repo's checkout — not overwritten by lib's.
      expect(resolve(siblings[0].worktreePath)).not.toBe(resolve(leadingWt));
      expect(existsSync(join(leadingWt, "app.txt"))).toBe(true);
      expect(existsSync(join(leadingWt, "lib.txt"))).toBe(false);
      expect(existsSync(join(siblings[0].worktreePath, "lib.txt"))).toBe(true);

      // The lead repo's worktree registration must still be intact.
      const leadWorktrees = await gitService.listWorktrees(lead);
      expect(leadWorktrees.some((wt) => resolve(wt.path) === resolve(leadingWt))).toBe(true);
    } finally {
      try { await rm(parent, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 60000);

  it("skips sibling cleanup while another live workspace still references the shared worktree/branch", async () => {
    // Regression (adversarial findings #5/#9): a second workspace on the same branch
    // reuses the first one's sibling worktrees (createWorktree's reuse path), so both
    // workspaces' repos rows point at ONE worktree/branch. Cleaning up one workspace
    // must not destroy the other's checkout or force-delete the shared branch — the
    // sibling analog of deleteWorkspace's findWorkspacesByWorkingDir guard.
    const wsA = randomUUID();
    const wsB = randomUUID();
    await db.insert(workspaces).values([
      { id: wsA, issueId, branch: "feature/guarded", status: "active" },
      { id: wsB, issueId, branch: "feature/guarded", status: "active" },
    ]);

    const siblings = await provisionSiblingWorktrees({
      gitService,
      database: db as unknown as Database,
      projectId,
      branch: "feature/guarded",
    });
    expect(siblings).toHaveLength(1);
    await insertSiblingWorktreeRecords(wsA, projectId, siblings, db);
    await insertSiblingWorktreeRecords(wsB, projectId, siblings, db);

    // Cleaning up A while B is still live must leave the shared worktree + branch alone.
    await cleanupSiblingWorktrees(gitService, wsA, db as unknown as Database);
    expect(existsSync(siblings[0].worktreePath)).toBe(true);
    expect((await exec("git", ["branch", "--list", "feature/guarded"], extraRepo)).trim()).not.toBe("");

    // Once B is closed there is no live sharer left — cleanup now removes both.
    await db.update(workspaces).set({ status: "closed" }).where(eq(workspaces.id, wsB));
    await cleanupSiblingWorktrees(gitService, wsA, db as unknown as Database);
    expect(existsSync(siblings[0].worktreePath)).toBe(false);
    expect((await exec("git", ["branch", "--list", "feature/guarded"], extraRepo)).trim()).toBe("");
  }, 60000);
});
