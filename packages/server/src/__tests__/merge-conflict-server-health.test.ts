/**
 * Regression test for #600 / #598:
 * A conflicting merge attempt must return 409 AND must NOT advance master
 * (no conflict markers committed). The server must also stay healthy after
 * the failed merge — this was the root failure mode that took down the dev
 * server during the #590 incident.
 *
 * This test operates at the route/server level (not git-service unit level)
 * using real git repos on disk.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { createHealthRoute } from "../routes/health.js";
import * as schema from "@agentic-kanban/shared/schema";
import type { TestDb } from "./helpers/test-db.js";

// ── Test app that mounts only the routes we need ────────────────────────────

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/workspaces", createWorkspaceActionsRoute(
      () => createMockSessionManager(),
      db,
    ));
    app.route("/api/health", createHealthRoute());
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function gitSetup(repoPath: string) {
  git(repoPath, "config", "user.email", "test@test.com");
  git(repoPath, "config", "user.name", "Test");
}

/**
 * Creates a repo layout that produces a real merge conflict:
 *   master: file.ts = "line A"
 *   feature: file.ts = "line B"   (both changed the same line independently)
 *
 * Returns { repoPath, featureBranch, worktreeDir }
 */
function createConflictingRepo(): { repoPath: string; featureBranch: string; worktreeDir: string } {
  const repoPath = mkdtempSync(join(tmpdir(), "kanban-test-conflict-"));

  // Init bare main branch with a file
  git(repoPath, "init", "-b", "master");
  gitSetup(repoPath);
  writeFileSync(join(repoPath, "file.ts"), "export const x = 'original';\n");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "init");

  // Feature branch: change the same file differently
  const featureBranch = "feature/ak-600-conflict-test";
  git(repoPath, "checkout", "-b", featureBranch);
  writeFileSync(join(repoPath, "file.ts"), "export const x = 'from-feature';\n");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "feature change");

  // Back to master, change the same file — creates an irreconcilable conflict
  git(repoPath, "checkout", "master");
  writeFileSync(join(repoPath, "file.ts"), "export const x = 'from-master';\n");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "master change");

  // Worktree for the feature branch
  const worktreeDir = mkdtempSync(join(tmpdir(), "kanban-test-wt-"));
  rmSync(worktreeDir, { recursive: true });
  git(repoPath, "worktree", "add", worktreeDir, featureBranch);

  return { repoPath, featureBranch, worktreeDir };
}

async function seedWorkspaceWithConflict(
  db: TestDb,
  repoPath: string,
  featureBranch: string,
  worktreeDir: string,
): Promise<{ workspaceId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Conflict Test Project",
    repoPath,
    repoName: "conflict-test",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: randomUUID(), projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 600,
    title: "Conflict regression test",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: featureBranch,
    workingDir: worktreeDir,
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    mergedAt: null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { workspaceId };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("merge conflict regression (#600 / #598)", () => {
  const cleanup: Array<() => void> = [];

  afterAll(() => {
    for (const fn of cleanup) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
  });

  it("returns 409 and does NOT advance master when the branch conflicts", async () => {
    const { repoPath, featureBranch, worktreeDir } = createConflictingRepo();
    cleanup.push(() => {
      try { git(repoPath, "worktree", "remove", "--force", worktreeDir); } catch { /* ok */ }
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
    });

    const { app, db } = createTestApp();
    const { workspaceId } = await seedWorkspaceWithConflict(db, repoPath, featureBranch, worktreeDir);

    const masterSHABefore = git(repoPath, "rev-parse", "master");

    const res = await app.request(`/api/workspaces/${workspaceId}/merge`, { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json() as { reason: string; conflictFiles?: string[] };
    expect(body.reason).toBe("conflict");
    expect(Array.isArray(body.conflictFiles)).toBe(true);
    expect(body.conflictFiles!.length).toBeGreaterThan(0);

    // Master must NOT have advanced — no new commit
    const masterSHAAfter = git(repoPath, "rev-parse", "master");
    expect(masterSHAAfter).toBe(masterSHABefore);

    // Master must NOT contain conflict markers — read the file directly
    const fileContent = execFileSync(
      "git", ["show", `master:file.ts`],
      { cwd: repoPath, encoding: "utf-8" },
    );
    expect(fileContent).not.toContain("<<<<<<<");
    expect(fileContent).not.toContain("=======");
    expect(fileContent).not.toContain(">>>>>>>");
  });

  it("server health endpoint remains responsive after a failed conflicting merge", async () => {
    const { repoPath, featureBranch, worktreeDir } = createConflictingRepo();
    cleanup.push(() => {
      try { git(repoPath, "worktree", "remove", "--force", worktreeDir); } catch { /* ok */ }
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
    });

    const { app, db } = createTestApp();
    const { workspaceId } = await seedWorkspaceWithConflict(db, repoPath, featureBranch, worktreeDir);

    // Trigger the conflicting merge
    const mergeRes = await app.request(`/api/workspaces/${workspaceId}/merge`, { method: "POST" });
    expect(mergeRes.status).toBe(409);

    // Server must still respond to requests — if a conflict crashed the server
    // process (the #590/#598 incident), this call would throw instead of returning.
    // The health endpoint may return 503 in a test environment (missing shared/dist
    // or node_modules paths), but as long as it returns a response body the server
    // is not crashed.
    const healthRes = await app.request("/api/health/deps");
    expect(healthRes.status).toBeLessThanOrEqual(503);
    const healthBody = await healthRes.json() as { ok: boolean; checks: unknown[] };
    expect(Array.isArray(healthBody.checks)).toBe(true);
  });
});
