/**
 * #1214 — the boot pass that gives EXISTING worktrees the `commit-msg` hook they never got.
 *
 * Fixing the installer only helps workspaces created after it. A live board carries dozens of
 * worktrees provisioned while the install silently failed, and every commit they make until
 * they are recreated goes unchecked — which is the whole reason the BOM commits kept landing
 * one pre-merge-gate failure at a time. So the pass is asserted against real worktrees: one
 * missing the hook, one already carrying it, and one whose row is a direct workspace.
 */
import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { reconcileCommitMsgHooks } from "../startup/commit-msg-hook-backfill.js";
import { installCommitMsgHook } from "../services/commit-msg-hook.js";

const tempDirs: string[] = [];
const IDENTITY = ["-c", "user.name=Backfill Test", "-c", "user.email=backfill@test.invalid"];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ak-hook-backfill-"));
  tempDirs.push(dir);
  await gitExec(["init", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await gitExec(["add", "seed.txt"], { cwd: dir });
  await gitExec([...IDENTITY, "commit", "-m", "seed"], { cwd: dir });
  return dir;
}

async function addWorktree(repo: string, name: string): Promise<string> {
  const path = join(repo, "..", `${name}-${randomUUID().slice(0, 8)}`);
  tempDirs.push(path);
  const res = await gitExec(["worktree", "add", "-b", name, path], { cwd: repo });
  expect(res.code, res.stderr).toBe(0);
  return path;
}

/** A project + issue + one workspace row pointing at `workingDir`. */
async function seedWorkspace(
  db: TestDb,
  workingDir: string | null,
  opts: { status?: string; isDirect?: boolean; tddMode?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Hook Backfill", repoPath: "/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1214, title: "hook backfill", statusId, projectId,
    createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: randomUUID(), issueId, branch: `feature/ak-1214-${randomUUID().slice(0, 8)}`,
    workingDir, baseBranch: "main", isDirect: opts.isDirect ?? false,
    tddMode: opts.tddMode ?? false, status: opts.status ?? "idle",
    createdAt: now, updatedAt: now,
  });
}

async function configuredHooksPath(worktree: string): Promise<string> {
  const res = await gitExec(["config", "--worktree", "--get", "core.hooksPath"], { cwd: worktree });
  return res.stdout.trim();
}

describe("reconcileCommitMsgHooks (#1214)", () => {
  it("installs the hook into a live worktree that has none", async () => {
    const { db } = createTestDb();
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, "wt-missing");
    await seedWorkspace(db, worktree);

    const result = await reconcileCommitMsgHooks({ database: db });

    expect(result.installed).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(join(resolve(worktree, await configuredHooksPath(worktree)), "commit-msg"))).toBe(true);
  });

  it("leaves a worktree that already has one alone — the pass is idempotent", async () => {
    const { db } = createTestDb();
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, "wt-present");
    await installCommitMsgHook(worktree, { tddMode: false });
    await seedWorkspace(db, worktree);

    const first = await reconcileCommitMsgHooks({ database: db });
    const second = await reconcileCommitMsgHooks({ database: db });

    expect(first.installed).toBe(0);
    expect(first.alreadyPresent).toBe(1);
    expect(second.alreadyPresent).toBe(1);
  });

  it("writes the TDD-gate variant for a workspace whose row says tddMode", async () => {
    const { db } = createTestDb();
    const repo = await makeRepo();
    const worktree = await addWorktree(repo, "wt-tdd");
    await seedWorkspace(db, worktree, { tddMode: true });

    await reconcileCommitMsgHooks({ database: db });

    const hooksDir = resolve(worktree, await configuredHooksPath(worktree));
    expect(existsSync(join(hooksDir, "commit-msg"))).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(hooksDir, "commit-msg"), "utf-8")).toContain("TDD mode: write failing AC tests first.");
  });

  it("never touches a DIRECT workspace — its 'worktree' is the operator's main checkout", async () => {
    const { db } = createTestDb();
    const repo = await makeRepo();
    await seedWorkspace(db, repo, { isDirect: true });

    const result = await reconcileCommitMsgHooks({ database: db });

    expect(result.scanned).toBe(0);
    expect(existsSync(join(repo, ".git", "hooks", "commit-msg"))).toBe(false);
  });

  it("skips a closed workspace and a worktree whose directory is gone, without failing the pass", async () => {
    const { db } = createTestDb();
    const repo = await makeRepo();
    const closed = await addWorktree(repo, "wt-closed");
    await seedWorkspace(db, closed, { status: "closed" });
    await seedWorkspace(db, join(repo, "..", "vanished-worktree"));

    const result = await reconcileCommitMsgHooks({ database: db });

    expect(result.scanned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("stops at its per-pass budget and says so, leaving the rest for the next pass", async () => {
    const { db } = createTestDb();
    const repo = await makeRepo();
    await seedWorkspace(db, await addWorktree(repo, "wt-budget-a"));
    await seedWorkspace(db, await addWorktree(repo, "wt-budget-b"));

    const result = await reconcileCommitMsgHooks({ database: db, maxPerPass: 1 });

    expect(result.installed).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
