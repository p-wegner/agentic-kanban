import { describe, it, expect, vi } from "vitest";
import { reconcileAbandonedProvisioning } from "../startup/startup-tasks.js";

/**
 * #630: the marker exists so an interrupted create is a REPORTED event instead of silent
 * debris. These pin the two properties that make it worth having — every abandoned record is
 * named and cleared, and a clearing failure never stops the rest of the boot.
 */
describe("reconcileAbandonedProvisioning", () => {
  const record = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "ws-1",
    issueId: "issue-1",
    projectId: "project-1",
    branch: "feature/ak-1-thing",
    worktreePath: null,
    serverPid: 4242,
    phase: "siblings",
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    ...over,
  });

  it("reports each abandoned create with its issue, branch and phase, then clears it", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const cleared = await reconcileAbandonedProvisioning({
      list: vi.fn().mockResolvedValue([record()]),
      finish,
      log: (msg) => lines.push(msg),
    });

    expect(cleared).toBe(1);
    expect(finish).toHaveBeenCalledWith("ws-1");
    const report = lines.join("\n");
    expect(report).toContain("issue-1");
    expect(report).toContain("feature/ak-1-thing");
    expect(report).toContain("siblings");
  });

  it("says nothing when there is nothing abandoned", async () => {
    const lines: string[] = [];
    const cleared = await reconcileAbandonedProvisioning({
      list: vi.fn().mockResolvedValue([]),
      finish: vi.fn(),
      log: (msg) => lines.push(msg),
    });
    expect(cleared).toBe(0);
    expect(lines).toEqual([]);
  });

  it("keeps going when a marker cannot be cleared", async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error("locked")).mockResolvedValue(undefined);
    const cleared = await reconcileAbandonedProvisioning({
      list: vi.fn().mockResolvedValue([record({ id: "ws-1" }), record({ id: "ws-2" })]),
      finish,
      log: () => {},
    });
    expect(cleared).toBe(2);
    expect(finish).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the marker table cannot be read at all", async () => {
    const cleared = await reconcileAbandonedProvisioning({
      list: vi.fn().mockRejectedValue(new Error("no such table")),
      finish: vi.fn(),
      log: () => {},
    });
    expect(cleared).toBe(0);
  });
});

describe("workspace_provisioning table (#630)", () => {
  it("round-trips a marker and only reports it as abandoned for a FOREIGN pid", async () => {
    const { createTestDb } = await import("./helpers/test-db.js");
    const repo = await import("../repositories/workspace-provisioning.repository.js");
    const { db } = createTestDb();

    const seed = await import("@agentic-kanban/shared/schema");
    await db.insert(seed.projects).values({ id: "p1", name: "p", repoPath: "/tmp/p" });
    await db.insert(seed.projectStatuses).values({ id: "s1", projectId: "p1", name: "Todo", sortOrder: 0 });
    await db.insert(seed.issues).values({ id: "i1", projectId: "p1", statusId: "s1", title: "t", issueNumber: 1 });

    await repo.beginProvisioning({ id: "w1", issueId: "i1", projectId: "p1", branch: "feature/x", worktreePath: null }, db);

    // Written by THIS process, so it is a live create, not debris.
    expect(await repo.listAbandonedProvisioning(db)).toEqual([]);

    await repo.updateProvisioning("w1", { phase: "siblings", worktreePath: "/tmp/wt" }, db);
    await db.update(seed.workspaceProvisioning).set({ serverPid: process.pid + 1 });

    const abandoned = await repo.listAbandonedProvisioning(db);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ id: "w1", issueId: "i1", phase: "siblings", worktreePath: "/tmp/wt" });

    await repo.finishProvisioning("w1", db);
    expect(await repo.listAbandonedProvisioning(db)).toEqual([]);
  });
});

/**
 * The whole point of the marker is WHEN it exists: during provisioning, and never after.
 * These drive the real create service (same harness as the #893 rollback tests) and observe
 * the table from inside `createWorktree` — i.e. exactly the window a restart used to make
 * invisible.
 */
describe("createWorkspace marker lifecycle (#630)", () => {
  it("holds a marker while the worktree is being provisioned and clears it on failure", async () => {
    const { randomUUID } = await import("node:crypto");
    const { createTestDb } = await import("./helpers/test-db.js");
    const { createWorkspaceCrudService } = await import("../services/workspace-crud.service.js");
    const s = await import("@agentic-kanban/shared/schema");
    const { db } = createTestDb();

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(s.projects).values({ id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now });
    // No "In Progress" status → the final transaction fails after the worktree exists.
    await db.insert(s.projectStatuses).values({ id: statusId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now });
    await db.insert(s.issues).values({ id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });

    let markerDuringProvisioning: unknown[] = [];
    const git = {
      createWorktree: vi.fn(async (_repo: string, branch: string) => {
        markerDuringProvisioning = await db.select().from(s.workspaceProvisioning);
        return `/tmp/worktrees/${branch}`;
      }),
      removeWorktree: vi.fn(async () => {}),
      getCurrentBranch: vi.fn(async () => "main"),
      getHeadCommitSha: vi.fn(async () => "abc123"),
      revParse: vi.fn(async () => "abc123"),
      pruneWorktrees: vi.fn(async () => {}),
      listWorktrees: vi.fn(async () => []),
      ensureOnBranch: vi.fn(async () => {}),
    };
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({ startSession: vi.fn(), stopSession: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }) as never,
      gitService: git as never,
    });

    const result = await svc.createWorkspace({
      issueId, branch: "feature/ak-1-test", isDirect: false, skipSetup: true, skipContextPacker: true,
    });

    expect(result.status).toBe("error");
    // Visible WHILE provisioning — this is the window a restart used to erase.
    expect(markerDuringProvisioning).toHaveLength(1);
    expect(markerDuringProvisioning[0]).toMatchObject({ issueId, projectId, branch: "feature/ak-1-test" });
    // Gone afterwards: a clean failure rolls its worktree back, so it is not debris.
    expect(await db.select().from(s.workspaceProvisioning)).toEqual([]);
  });

  it("clears the marker in the same commit that makes the workspace real", async () => {
    const { randomUUID } = await import("node:crypto");
    const { createTestDb } = await import("./helpers/test-db.js");
    const { createWorkspaceCrudService } = await import("../services/workspace-crud.service.js");
    const s = await import("@agentic-kanban/shared/schema");
    const { db } = createTestDb();

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(s.projects).values({ id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now });
    await db.insert(s.projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
    await db.insert(s.issues).values({ id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });

    const git = {
      createWorktree: vi.fn(async (_repo: string, branch: string) => `/tmp/worktrees/${branch}`),
      removeWorktree: vi.fn(async () => {}),
      getCurrentBranch: vi.fn(async () => "main"),
      getHeadCommitSha: vi.fn(async () => "abc123"),
      revParse: vi.fn(async () => "abc123"),
      pruneWorktrees: vi.fn(async () => {}),
      listWorktrees: vi.fn(async () => []),
      ensureOnBranch: vi.fn(async () => {}),
    };
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({ startSession: vi.fn(), stopSession: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }) as never,
      gitService: git as never,
    });

    const result = await svc.createWorkspace({
      issueId, branch: "feature/ak-2-test", isDirect: false, skipSetup: true, skipContextPacker: true,
    });

    expect(result.status).not.toBe("error");
    expect(await db.select().from(s.workspaceProvisioning)).toEqual([]);
    const rows = await db.select().from(s.workspaces);
    expect(rows).toHaveLength(1);
  });
});
