// @covers tracker-snapshot [aggregate, api]
/**
 * GET /api/projects/:id/tracker-snapshot (#1140) — a compact, poll-friendly board
 * summary for a terminal tracker. Asserts per-column counts, WIP limit + active builder
 * count, in-flight workspace entries, blocked/stalled reasons, review-queue depth and
 * base-branch health against a seeded DB, at the HTTP layer.
 */
import { Hono } from "hono";
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createTrackerSnapshotRoute } from "../routes/tracker-snapshot.js";
import { recordBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import type { TrackerSnapshotResponse } from "@agentic-kanban/shared";

function mountRoute(db: ReturnType<typeof createTestDb>["db"]) {
  const app = new Hono();
  app.route("/api/projects", createTrackerSnapshotRoute(db as never));
  return app;
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Tracker Snapshot Project", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });

  const todoId = randomUUID();
  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  await db.insert(projectStatuses).values([
    { id: todoId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inProgressId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
    { id: inReviewId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
  ]);

  return { projectId, todoId, inProgressId, inReviewId };
}

async function seedIssue(
  db: ReturnType<typeof createTestDb>["db"],
  projectId: string,
  statusId: string,
  issueNumber: number,
  title: string,
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber, title, priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return issueId;
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  issueId: string,
  opts: { status: string; readyForMerge?: boolean; createdAt?: string },
) {
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: `feature/ws-${workspaceId.slice(0, 8)}`,
    workingDir: "/repo",
    baseBranch: "master", isDirect: false,
    status: opts.status,
    readyForMerge: opts.readyForMerge ?? false,
    provider: "claude",
    createdAt: opts.createdAt ?? now,
    updatedAt: now,
  });
  return workspaceId;
}

async function seedSession(
  db: ReturnType<typeof createTestDb>["db"],
  workspaceId: string,
  opts: { status: string; startedAt: string; endedAt?: string | null },
) {
  const sessionId = randomUUID();
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code",
    status: opts.status, startedAt: opts.startedAt, endedAt: opts.endedAt ?? null,
    triggerType: "chat",
  });
  return sessionId;
}

describe("GET /api/projects/:id/tracker-snapshot", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("returns 404 for an unknown project", async () => {
    const app = mountRoute(db);
    const res = await app.request(`/api/projects/${randomUUID()}/tracker-snapshot`);
    expect(res.status).toBe(404);
  });

  it("aggregates column counts, in-flight workspaces, blocked reasons, review depth and base health", async () => {
    const { projectId, todoId, inProgressId, inReviewId } = await seedProject(db);

    const backlogIssue = await seedIssue(db, projectId, todoId, 1, "Backlog ticket");
    void backlogIssue;

    const activeIssue = await seedIssue(db, projectId, inProgressId, 2, "Active ticket");
    const oldCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const activeWorkspaceId = await seedWorkspace(db, activeIssue, { status: "active", createdAt: oldCreatedAt });
    const sessionStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10m ago
    await seedSession(db, activeWorkspaceId, { status: "running", startedAt: sessionStartedAt, endedAt: null });

    const blockedIssue = await seedIssue(db, projectId, inProgressId, 3, "Blocked ticket");
    await seedWorkspace(db, blockedIssue, { status: "blocked" });

    const reviewIssue = await seedIssue(db, projectId, inReviewId, 4, "In review ticket");
    await seedWorkspace(db, reviewIssue, { status: "reviewing" });

    const readyIssue = await seedIssue(db, projectId, inReviewId, 5, "Ready to merge ticket");
    await seedWorkspace(db, readyIssue, { status: "idle", readyForMerge: true });

    await recordBaseBranchHealth(
      { projectId, sha: "deadbeef00000000000000000000000000000000", branch: "master", outcome: "green" },
      db,
    );

    const app = mountRoute(db);
    const res = await app.request(`/api/projects/${projectId}/tracker-snapshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrackerSnapshotResponse;

    // Per-column counts, in the project's own column order.
    expect(body.columns).toEqual([
      { statusId: todoId, name: "Todo", count: 1 },
      { statusId: inProgressId, name: "In Progress", count: 2 },
      { statusId: inReviewId, name: "In Review", count: 2 },
    ]);

    // In-flight: active + reviewing workspaces occupy a WIP slot; idle/blocked do not.
    expect(body.inFlight).toHaveLength(2);
    const activeEntry = body.inFlight.find((w) => w.workspaceId === activeWorkspaceId);
    expect(activeEntry).toMatchObject({
      issueNumber: 2,
      title: "Active ticket",
      statusName: "In Progress",
      agentState: "active",
    });
    expect(activeEntry!.ageMs).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(activeEntry!.lastOutputAgeMs).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(body.inFlight.some((w) => w.statusName === "In Review" && w.agentState === "reviewing")).toBe(true);

    expect(body.activeBuilderCount).toBe(2);

    // Blocked: the blocked workspace surfaces with a reason.
    expect(body.blocked).toHaveLength(1);
    expect(body.blocked[0]).toMatchObject({ issueNumber: 3, title: "Blocked ticket" });
    expect(body.blocked[0].reason).toContain("blocked");

    // Review queue depth: "reviewing" status + readyForMerge=true workspace.
    expect(body.reviewQueueDepth).toBe(2);

    // Base-branch health surfaced from the latest recorded probe.
    expect(body.baseBranchHealth).toMatchObject({ outcome: "green", sha: "deadbeef00000000000000000000000000000000" });

    // WIP limit resolves to the default (no Strategy Bullseye configured).
    expect(body.wipLimit).toBeGreaterThan(0);
    expect(body.projectId).toBe(projectId);
  });

  it("returns an empty snapshot for a project with no issues", async () => {
    const { projectId } = await seedProject(db);
    const app = mountRoute(db);
    const res = await app.request(`/api/projects/${projectId}/tracker-snapshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrackerSnapshotResponse;

    expect(body.inFlight).toEqual([]);
    expect(body.blocked).toEqual([]);
    expect(body.reviewQueueDepth).toBe(0);
    expect(body.baseBranchHealth).toBeNull();
    expect(body.columns.every((c) => c.count === 0)).toBe(true);
  });
});
