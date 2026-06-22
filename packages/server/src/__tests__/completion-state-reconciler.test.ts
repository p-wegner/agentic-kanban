import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileCompletionStates } from "../startup/completion-state-reconciler.js";

function makeNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function setupScenario(db: ReturnType<typeof createTestDb>["db"], opts: {
  issueStatusName?: string;
  workspaceStatus?: string;
  sessionPid?: number | null;
  sessionStatus?: "running" | "completed" | "stopped";
  workspaceUpdatedAt?: string;
}) {
  const now = makeNow();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/tmp/test",
    repoName: "test",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: opts.issueStatusName ?? "In Review",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  await db.insert(issues).values({
    id: issueId,
    projectId,
    statusId,
    title: "Test issue",
    issueNumber: 1,
    createdAt: now,
    updatedAt: now,
  });

  const wsUpdatedAt = opts.workspaceUpdatedAt ?? now;
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-1-test",
    status: opts.workspaceStatus ?? "active",
    workingDir: "/tmp/worktree",
    baseBranch: "main",
    isDirect: false,
    createdAt: now,
    updatedAt: wsUpdatedAt,
  });

  await db.insert(sessions).values({
    id: sessionId,
    workspaceId,
    executor: "claude-code",
    status: opts.sessionStatus ?? "running",
    startedAt: now,
    pid: opts.sessionPid !== undefined ? opts.sessionPid : null,
  });

  return { projectId, statusId, issueId, workspaceId, sessionId };
}

describe("reconcileCompletionStates", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
  });

  it("marks session stopped and workspace idle when PID is null (dead)", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");
    expect(session.endedAt).not.toBeNull();

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("marks session stopped and workspace idle when PID is dead and workspace has committed changes", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 99999,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("does NOT reconcile a dead-PID session when workspace has no committed changes (protects in-flight work)", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "active",
      sessionPid: 99999,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => false,
      checkCommits: async () => false,
    });

    expect(count).toBe(0);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("active");
  });

  it("reconciles hung agent: PID alive but issue is in Review and workspace stuck >30min", async () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      workspaceUpdatedAt: staleTime,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => true,
      checkCommits: async () => true,
      now: new Date().toISOString(),
    });

    expect(count).toBe(1);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("does NOT reconcile a workspace whose PID is alive and issue is still In Progress", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "active",
      sessionPid: 12345,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => true,
      checkCommits: async () => false,
    });

    expect(count).toBe(0);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("active");
  });

  it("does NOT reconcile a workspace where PID is alive and issue is In Review but workspace updated recently", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { sessionId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      workspaceUpdatedAt: recentTime,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => true,
      checkCommits: async () => true,
      now: new Date().toISOString(),
    });

    expect(count).toBe(0);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");
  });

  it("does not touch already-stopped sessions", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/t", repoName: "t", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now });
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "T", issueNumber: 2, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/t", status: "idle", workingDir: "/t", baseBranch: "main", isDirect: false, createdAt: now, updatedAt: now });
    await db.insert(sessions).values({ id: sessionId, workspaceId, executor: "claude-code", status: "stopped", startedAt: now, pid: null });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(0);
  });

  // ─── blocked workspace auto-recovery (#712) ──────────────────────────────────

  it("auto-recovers blocked workspace to idle when session completed with committed changes", async () => {
    const { workspaceId, sessionId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "blocked",
      sessionStatus: "completed",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");

    // Session status is not changed by blocked recovery — it already completed
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("completed");
  });

  it("auto-recovers blocked workspace to idle when session stopped with committed changes", async () => {
    const { workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "blocked",
      sessionStatus: "stopped",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("does NOT auto-recover blocked workspace when session has no committed changes", async () => {
    const { workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "blocked",
      sessionStatus: "completed",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => false,
    });

    expect(count).toBe(0);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("blocked");
  });

  it("does NOT auto-recover blocked workspace when workingDir or baseBranch is missing", async () => {
    const now = makeNow();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "T2", repoPath: "/t2", repoName: "t2", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "T2", issueNumber: 3, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/t2",
      status: "blocked",
      workingDir: null,
      baseBranch: null,
      isDirect: false, createdAt: now, updatedAt: now,
    });
    await db.insert(sessions).values({ id: sessionId, workspaceId, executor: "claude-code", status: "completed", startedAt: now, pid: null });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(0);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("blocked");
  });
});
