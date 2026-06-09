/**
 * Unit tests for workspace-lifecycle-reconcile.service — ticket #637.
 *
 * Verifies that each lifecycle transition can be triggered independently:
 *   1. closeWorkspace — workspace status/timestamp/flag transitions in isolation
 *   2. stopWorkspaceSessions — session stop step in isolation
 *
 * reconcileMergedIssue (issue status) is already tested in isolation in
 * reconciler.service.test.ts and workspace-lifecycle-transitions.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  closeWorkspace,
  stopWorkspaceSessions,
} from "../services/workspace-lifecycle-reconcile.service.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    status?: string;
    readyForMerge?: boolean;
    closedAt?: string | null;
    mergedAt?: string | null;
    workingDir?: string | null;
  } = {},
) {
  const now = new Date(Date.now() - 60_000).toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 0, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 637, title: "Lifecycle reconcile test",
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-637-test",
    workingDir: opts.workingDir !== undefined ? opts.workingDir : "/repo/.worktrees/ak-637",
    baseBranch: "master",
    isDirect: false,
    status: opts.status ?? "idle",
    readyForMerge: opts.readyForMerge ?? true,
    closedAt: opts.closedAt ?? null,
    mergedAt: opts.mergedAt ?? null,
    provider: "claude",
    createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

async function seedSession(
  db: ReturnType<typeof createTestDb>["db"],
  workspaceId: string,
  status: "running" | "stopped" | "completed",
) {
  const sessionId = randomUUID();
  const now = new Date(Date.now() - 60_000).toISOString();
  await db.insert(sessions).values({
    id: sessionId, workspaceId, status, startedAt: now,
  });
  return sessionId;
}

// ─── closeWorkspace ───────────────────────────────────────────────────────────

describe("closeWorkspace: lifecycle status transition (independent)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("sets workspace status to closed, clears readyForMerge, stamps closedAt and mergedAt", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "idle", readyForMerge: true });
    const now = new Date().toISOString();

    await closeWorkspace({ database: db, workspaceId, now });

    const [ws] = await db.select({
      status: workspaces.status,
      readyForMerge: workspaces.readyForMerge,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
    }).from(workspaces).where(eq(workspaces.id, workspaceId));

    expect(ws.status).toBe("closed");
    expect(ws.readyForMerge).toBe(false);
    expect(ws.closedAt).toBe(now);
    expect(ws.mergedAt).toBe(now);
  });

  it("returns workspaceUpdated=true when workspace was not closed", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "reviewing" });

    const result = await closeWorkspace({ database: db, workspaceId });

    expect(result.workspaceUpdated).toBe(true);
  });

  it("is idempotent: returns workspaceUpdated=false when already closed", async () => {
    const closedAt = new Date(Date.now() - 5_000).toISOString();
    const mergedAt = closedAt;
    const { workspaceId } = await seedWorkspace(db, {
      status: "closed",
      readyForMerge: false,
      closedAt,
      mergedAt,
    });

    const result = await closeWorkspace({ database: db, workspaceId, closedAt, mergedAt });

    expect(result.workspaceUpdated).toBe(false);
    expect(result.closedAt).toBe(closedAt);
    expect(result.mergedAt).toBe(mergedAt);
  });

  it("preserves existing closedAt on retry (does not rewrite merge history)", async () => {
    const originalClosedAt = new Date(Date.now() - 10_000).toISOString();
    const { workspaceId } = await seedWorkspace(db, {
      status: "closed",
      readyForMerge: false,
      closedAt: originalClosedAt,
      mergedAt: originalClosedAt,
    });

    const result = await closeWorkspace({
      database: db, workspaceId,
      closedAt: new Date().toISOString(), // later timestamp — must NOT win
    });

    expect(result.closedAt).toBe(originalClosedAt);
  });

  it("skips mergedAt when markMerged=false", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "active", mergedAt: null });
    const now = new Date().toISOString();

    const result = await closeWorkspace({ database: db, workspaceId, now, markMerged: false });

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
    expect(result.mergedAt).toBeNull();
  });

  it("clears workingDir when clearWorkingDir=true", async () => {
    const { workspaceId } = await seedWorkspace(db, {
      status: "idle",
      workingDir: "/repo/.worktrees/ak-637",
    });

    await closeWorkspace({ database: db, workspaceId, clearWorkingDir: true });

    const [ws] = await db.select({ workingDir: workspaces.workingDir })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.workingDir).toBeNull();
  });

  it("does not clear workingDir when clearWorkingDir is not set", async () => {
    const { workspaceId } = await seedWorkspace(db, {
      status: "idle",
      workingDir: "/repo/.worktrees/ak-637",
    });

    await closeWorkspace({ database: db, workspaceId });

    const [ws] = await db.select({ workingDir: workspaces.workingDir })
      .from(workspaces).where(eq(workspaceId, workspaces.id));
    expect(ws.workingDir).toBe("/repo/.worktrees/ak-637");
  });

  it("throws when workspace does not exist", async () => {
    await expect(
      closeWorkspace({ database: db, workspaceId: randomUUID() }),
    ).rejects.toThrow("Workspace not found");
  });
});

// ─── stopWorkspaceSessions ────────────────────────────────────────────────────

describe("stopWorkspaceSessions: session stop step (independent)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("stops running sessions and returns true", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const sessionId = await seedSession(db, workspaceId, "running");
    const endedAt = new Date().toISOString();

    const stopped = await stopWorkspaceSessions(db, workspaceId, endedAt);

    expect(stopped).toBe(true);

    const [session] = await db.select({ status: sessions.status, endedAt: sessions.endedAt })
      .from(sessions).where(eq(sessions.id, sessionId));
    expect(session.status).toBe("stopped");
    expect(session.endedAt).toBe(endedAt);
  });

  it("returns false when no running sessions exist", async () => {
    const { workspaceId } = await seedWorkspace(db);
    await seedSession(db, workspaceId, "stopped");

    const stopped = await stopWorkspaceSessions(db, workspaceId, new Date().toISOString());

    expect(stopped).toBe(false);
  });

  it("returns false when workspace has no sessions at all", async () => {
    const { workspaceId } = await seedWorkspace(db);

    const stopped = await stopWorkspaceSessions(db, workspaceId, new Date().toISOString());

    expect(stopped).toBe(false);
  });

  it("only stops running sessions, not already-stopped or completed ones", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const stoppedId = await seedSession(db, workspaceId, "stopped");
    const runningId = await seedSession(db, workspaceId, "running");
    const endedAt = new Date().toISOString();

    await stopWorkspaceSessions(db, workspaceId, endedAt);

    const [stoppedSession] = await db.select({ endedAt: sessions.endedAt })
      .from(sessions).where(eq(sessions.id, stoppedId));
    // The already-stopped session's endedAt must not have been overwritten
    expect(stoppedSession.endedAt).toBeNull();

    const [runningSession] = await db.select({ status: sessions.status })
      .from(sessions).where(eq(sessions.id, runningId));
    expect(runningSession.status).toBe("stopped");
  });
});

// ─── independence: transitions work without each other ───────────────────────

describe("lifecycle transitions are independent", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("closeWorkspace succeeds without any sessions present", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "reviewing" });

    // No sessions seeded — must not throw
    const result = await closeWorkspace({ database: db, workspaceId });

    expect(result.workspaceUpdated).toBe(true);
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
  });

  it("stopWorkspaceSessions succeeds without touching workspace status", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "active" });
    await seedSession(db, workspaceId, "running");

    await stopWorkspaceSessions(db, workspaceId, new Date().toISOString());

    // Workspace status must be untouched — stopWorkspaceSessions is narrowly scoped
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("active");
  });
});
