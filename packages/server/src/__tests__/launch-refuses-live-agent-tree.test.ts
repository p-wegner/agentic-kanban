import { describe, expect, it, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";
import { WorkspaceError } from "../services/workspace-internals.js";

/**
 * #968: `POST /api/workspaces/:id/launch` must refuse while a previous session's agent process
 * tree is still alive.
 *
 * The incident it prevents: board session 62c6722d was recorded `completed` with exit 0 while
 * its claude.exe kept running and kept WORKING — opening a new transcript after its recorded
 * end, editing files, running the full verify chain. The workspace showed no running session,
 * so the driving session relaunched it, which is exactly what the endpoint is for. Two agents
 * then co-edited one worktree on one branch for ~20 minutes; nothing interleaved into a commit
 * only because both happened to notice each other.
 *
 * The caller could not see the zombie, so the guard has to live in the API. It asks the
 * OPERATING SYSTEM rather than the session table, because the session table is precisely what
 * was wrong.
 *
 * PID liveness here is REAL, not mocked: the "still alive" case is seeded with `process.pid`
 * (this test process, guaranteed alive) and the "exited" case with a pid that cannot exist, so
 * `process.kill(pid, 0)` actually drives the branch — the same technique
 * `agent-sessions-reattach-recover.test.ts` uses.
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-968-launch-guard-"));
  tempDirs.push(dir);
  return dir;
}

async function seedWorkspace(db: TestDb, worktreePath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/does-not-matter-repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(schema.issues).values({
    id: issueId, issueNumber: 968, title: "Relaunch must not double-launch", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-968", workingDir: worktreePath,
    baseBranch: "main", isDirect: false, status: "idle", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

/**
 * The exact shape of the incident: a session the board believes finished cleanly. `completed`
 * with exit 0 is deliberately the status seeded here — a guard that filtered by status would
 * skip precisely this row and reintroduce the bug.
 */
async function seedCompletedSession(
  db: TestDb,
  workspaceId: string,
  pid: number,
  endedAt: string = new Date().toISOString(),
): Promise<string> {
  const sessionId = randomUUID();
  await db.insert(schema.sessions).values({
    id: sessionId, workspaceId, status: "completed", pid,
    startedAt: endedAt, endedAt, exitCode: "0", executor: "claude-code",
  });
  return sessionId;
}

describe("launchSession refuses a relaunch over a live agent tree (#968)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows locks */ }
    }
  });

  it("refuses when a 'completed' session's process is still alive", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());
    await seedCompletedSession(db, workspaceId, process.pid);

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({ database: db, getSessionManager: () => sessionManager });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(service.launchSession(workspaceId)).rejects.toThrow(WorkspaceError);
      await expect(service.launchSession(workspaceId)).rejects.toMatchObject({
        code: "CONFLICT",
        data: expect.objectContaining({ reason: "LIVE_AGENT_TREE" }),
      });
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("does not start a session when it refuses — the whole point is that nothing launches", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());
    await seedCompletedSession(db, workspaceId, process.pid);

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({ database: db, getSessionManager: () => sessionManager });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await service.launchSession(workspaceId).catch(() => {});
      expect(sessionManager.startSession).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("refuses BEFORE any worktree side effect — a rebase under a live agent is worse than the double launch", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());
    await seedCompletedSession(db, workspaceId, process.pid);

    const provision = {
      materializeWorkspaceSkills: vi.fn(async () => {}),
      writeWorktreeTicketContext: vi.fn(async () => null),
    } as unknown as Parameters<typeof createWorkspaceSessionService>[0]["provision"];

    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => createMockSessionManager(),
      provision,
    });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await service.launchSession(workspaceId).catch(() => {});
      // Re-materialization writes into a worktree the live agent may be reading.
      expect((provision as unknown as { materializeWorkspaceSkills: ReturnType<typeof vi.fn> })
        .materializeWorkspaceSkills).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("launches normally when the previous session's process is genuinely gone", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());
    // A pid that cannot exist: the guard must not become a permanent block on every workspace
    // that ever ran an agent.
    await seedCompletedSession(db, workspaceId, 2_147_483_600);

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({ database: db, getSessionManager: () => sessionManager });

    await expect(service.launchSession(workspaceId)).resolves.toEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });

  it("launches normally when the workspace has no prior session at all", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({ database: db, getSessionManager: () => sessionManager });

    await expect(service.launchSession(workspaceId)).resolves.toEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });

  it("force: true keeps the old behavior reachable", async () => {
    // The operator who just killed the zombie by hand should not have to wait for a process
    // table to agree with them.
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());
    await seedCompletedSession(db, workspaceId, process.pid);

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({ database: db, getSessionManager: () => sessionManager });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(service.launchSession(workspaceId, { force: true })).resolves.toEqual(
        expect.objectContaining({ sessionId: expect.any(String) }),
      );
      // An override must be loud: it is the one path that can produce the #968 state on purpose.
      expect(consoleWarnSpy.mock.calls.some((call) => String(call[0]).includes("force=true"))).toBe(true);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("launches over an OLD session whose pid has since been recycled onto something else", async () => {
    // `sessions.pid` is never cleared and a pid is not durable, so a week-old row can hold a
    // pid the OS has handed to an unrelated live process. `process.pid` stands in for exactly
    // that. Without the recency window this workspace could never be relaunched again —
    // including by the monitor, which passes no `force`.
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());
    const weekOld = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    await seedCompletedSession(db, workspaceId, process.pid, weekOld);

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({ database: db, getSessionManager: () => sessionManager });

    await expect(service.launchSession(workspaceId)).resolves.toEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });

  it("ignores a fleet session, whose liveness is the worker's question and not this machine's", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db, makeTempDir());
    // No host pid by construction. Probing the board's own process table would answer about
    // the wrong machine.
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.sessions).values({
      id: sessionId, workspaceId, status: "completed", pid: null,
      startedAt: now, endedAt: now, exitCode: "0", executor: "claude-code",
    });

    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => createMockSessionManager(),
    });

    await expect(service.launchSession(workspaceId)).resolves.toEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });
});
