/**
 * Unit tests for the zombie fix-and-merge session reconciler (#596).
 *
 * A zombie session is one that is marked 'running' but has:
 *   - no live provider process (PID dead or absent), and
 *   - zero output messages, and
 *   - started more than GRACE_WINDOW_MS ago.
 *
 * The reconciler must stop such sessions and reset the workspace to 'idle'
 * so the next monitor pass can re-trigger fix-and-merge.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileZombieFixSessions } from "../startup/zombie-fix-session-reconciler.js";
import type { BoardEvents } from "../services/board-events.js";

// Grace window matches the implementation constant.
const GRACE_WINDOW_MS = 60_000;

function makeDeps(db: ReturnType<typeof createTestDb>["db"], overrides: { enabled?: boolean } = {}) {
  const boardEvents = { broadcast: vi.fn(), broadcastActivity: vi.fn() } as unknown as BoardEvents;
  return {
    database: db,
    boardEvents,
    ...overrides,
  };
}

type TestData = {
  projectId: string;
  issueId: string;
  workspaceId: string;
  inReviewStatusId: string;
  inProgressStatusId: string;
};

async function seedFixingWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { workspaceStatus?: string } = {},
): Promise<TestData> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const inProgressStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 1, isDefault: true, createdAt: now },
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 596,
    title: "Zombie fix test",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-596-test",
    workingDir: "/repo/.worktrees/ws",
    baseBranch: "master",
    isDirect: false,
    status: opts.workspaceStatus ?? "fixing",
    readyForMerge: false,
    mergedAt: null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, inReviewStatusId, inProgressStatusId };
}

async function insertSession(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    workspaceId: string;
    triggerType: string;
    startedAt: string;
    pid?: number | null;
    status?: string;
  },
): Promise<string> {
  const sessionId = randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    workspaceId: opts.workspaceId,
    executor: "claude-code",
    status: opts.status ?? "running",
    startedAt: opts.startedAt,
    pid: opts.pid ?? null,
    triggerType: opts.triggerType,
  });
  return sessionId;
}

function oldEnough(): string {
  return new Date(Date.now() - GRACE_WINDOW_MS - 5_000).toISOString();
}

function tooFresh(): string {
  return new Date(Date.now() - 10_000).toISOString();
}

describe("reconcileZombieFixSessions", () => {

  it("returns 0 when disabled via deps.enabled=false", async () => {
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db);
    await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "fix-and-merge",
      startedAt: oldEnough(),
      pid: null,
    });

    const count = await reconcileZombieFixSessions(makeDeps(db, { enabled: false }));
    expect(count).toBe(0);
  });

  it("returns 0 when disabled via DB preference", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    await db
      .insert(preferences)
      .values({ key: "reconciler_zombie_fix_enabled", value: "false", updatedAt: now })
      .onConflictDoUpdate({
        target: preferences.key,
        set: { value: "false", updatedAt: now },
      });
    const data = await seedFixingWorkspace(db);
    await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "fix-and-merge",
      startedAt: oldEnough(),
      pid: null,
    });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(0);
  });

  it("reconciles a zombie fix-and-merge session (no PID, 0 messages, old enough)", async () => {
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db);
    const sessionId = await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "fix-and-merge",
      startedAt: oldEnough(),
      pid: null,
    });

    const deps = makeDeps(db);
    const count = await reconcileZombieFixSessions(deps);

    expect(count).toBe(1);

    // Session should be stopped.
    const [sess] = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId));
    expect(sess.status).toBe("stopped");

    // Workspace should be idle.
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, data.workspaceId));
    expect(ws.status).toBe("idle");

    // Board events should be broadcast.
    expect((deps.boardEvents.broadcast as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(deps.boardEvents.broadcast).toHaveBeenCalledWith(data.projectId, "workspace_idle");
    expect(deps.boardEvents.broadcast).toHaveBeenCalledWith(data.projectId, "issue_updated");
  });

  it("reconciles a zombie review session", async () => {
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db, { workspaceStatus: "reviewing" });
    const sessionId = await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "review",
      startedAt: oldEnough(),
      pid: null,
    });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(1);

    const [sess] = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId));
    expect(sess.status).toBe("stopped");

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, data.workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("skips a session that is still within the grace window", async () => {
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db);
    await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "fix-and-merge",
      startedAt: tooFresh(),
      pid: null,
    });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(0);

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, data.workspaceId));
    expect(ws.status).toBe("fixing"); // unchanged
  });

  it("skips a session that has output messages", async () => {
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db);
    const sessionId = await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "fix-and-merge",
      startedAt: oldEnough(),
      pid: null,
    });
    // Insert a message — this session is NOT a zombie.
    await db.insert(sessionMessages).values({
      sessionId,
      type: "stdout",
      data: "some output",
      createdAt: new Date().toISOString(),
    });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(0);

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, data.workspaceId));
    expect(ws.status).toBe("fixing"); // unchanged
  });

  it("skips a session whose provider process is still alive (pid = own process)", async () => {
    // Use the current process's PID — guaranteed to be alive — so process.kill(pid, 0)
    // succeeds (no throw) and the reconciler correctly skips the session.
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db);
    await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "fix-and-merge",
      startedAt: oldEnough(),
      pid: process.pid, // current node process — definitely alive
    });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(0);

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, data.workspaceId));
    expect(ws.status).toBe("fixing"); // unchanged
  });

  it("skips a session whose workspace is not in fixing/reviewing status", async () => {
    // If another reconciler already reset the workspace, don't double-process.
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db, { workspaceStatus: "idle" });
    await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "fix-and-merge",
      startedAt: oldEnough(),
      pid: null,
    });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(0);
  });

  it("skips sessions with triggerType other than fix-and-merge or review", async () => {
    const { db } = createTestDb();
    const data = await seedFixingWorkspace(db, { workspaceStatus: "active" });
    await insertSession(db, {
      workspaceId: data.workspaceId,
      triggerType: "manual",
      startedAt: oldEnough(),
      pid: null,
    });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(0);
  });

  it("reconciles multiple zombie sessions in a single tick", async () => {
    const { db } = createTestDb();
    const d1 = await seedFixingWorkspace(db);
    const d2 = await seedFixingWorkspace(db);

    await insertSession(db, { workspaceId: d1.workspaceId, triggerType: "fix-and-merge", startedAt: oldEnough(), pid: null });
    await insertSession(db, { workspaceId: d2.workspaceId, triggerType: "fix-and-merge", startedAt: oldEnough(), pid: null });

    const count = await reconcileZombieFixSessions(makeDeps(db));
    expect(count).toBe(2);
  });
});
