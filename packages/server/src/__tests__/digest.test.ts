import { describe, it, expect, beforeAll } from "vitest";
import { createDigestRoute } from "../routes/digest.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/digest", createDigestRoute(db));
  });
}

// Fixed "now" for the request; seed data is offset relative to it so the
// time-window logic is deterministic regardless of wall clock.
const NOW = "2026-05-30T12:00:00.000Z";
function hoursAgo(h: number): string {
  return new Date(new Date(NOW).getTime() - h * 60 * 60 * 1000).toISOString();
}

async function seedProject(db: TestDb, name: string) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.projects).values({
    id, name, repoPath: `/tmp/${name}`, repoName: name,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return id;
}

async function seedStatus(db: TestDb, projectId: string, name: string, sortOrder: number) {
  const id = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id, projectId, name, sortOrder, isDefault: sortOrder === 0, createdAt: new Date().toISOString(),
  });
  return id;
}

async function seedIssue(
  db: TestDb,
  projectId: string,
  statusId: string,
  fields: { issueNumber: number; title: string; createdAt: string; statusChangedAt?: string | null; priority?: string },
) {
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id,
    projectId,
    statusId,
    issueNumber: fields.issueNumber,
    title: fields.title,
    priority: fields.priority ?? "medium",
    issueType: "task",
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
    statusChangedAt: fields.statusChangedAt ?? null,
  });
  return id;
}

describe("Standup Digest", () => {
  const { app, db } = createTestApp();
  let projectId: string;
  let todoId: string;
  let inProgressId: string;
  let doneId: string;
  let issue2Id: string;

  beforeAll(async () => {
    projectId = await seedProject(db, "digest-proj");
    todoId = await seedStatus(db, projectId, "Todo", 0);
    inProgressId = await seedStatus(db, projectId, "In Progress", 1);
    doneId = await seedStatus(db, projectId, "Done", 2);

    // Created 2h ago, still Todo → counts as "created"
    await seedIssue(db, projectId, todoId, { issueNumber: 1, title: "Fresh issue", createdAt: hoursAgo(2) });

    // Created 10 days ago, moved to Done 3h ago → "completed", not "created"
    issue2Id = await seedIssue(db, projectId, doneId, {
      issueNumber: 2, title: "Old issue just finished", createdAt: hoursAgo(240), statusChangedAt: hoursAgo(3),
    });

    // Created 10 days ago, moved to In Progress 5h ago → "moved"
    await seedIssue(db, projectId, inProgressId, {
      issueNumber: 3, title: "Picked up an old one", createdAt: hoursAgo(240), statusChangedAt: hoursAgo(5),
    });

    // Created 10 days ago, moved 4 days ago → outside the 24h window
    await seedIssue(db, projectId, inProgressId, {
      issueNumber: 4, title: "Stale move", createdAt: hoursAgo(240), statusChangedAt: hoursAgo(96),
    });
  });

  it("requires projectId", async () => {
    const res = await app.request("/api/digest?range=24h");
    expect(res.status).toBe(400);
  });

  it("counts created/completed/moved within the 24h window", async () => {
    const res = await app.request(`/api/digest?projectId=${projectId}&range=24h&now=${encodeURIComponent(NOW)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.range).toBe("24h");
    expect(body.headline.createdCount).toBe(1);
    expect(body.created[0].issueNumber).toBe(1);

    expect(body.headline.completedCount).toBe(1);
    expect(body.completed[0].issueNumber).toBe(2);

    // Issue 3 moved 5h ago (in window); issue 4 moved 96h ago (out of window).
    const movedNumbers = body.moved.map((m: any) => m.issueNumber);
    expect(movedNumbers).toContain(3);
    expect(movedNumbers).not.toContain(4);
  });

  it("widening the window picks up the stale move", async () => {
    const res = await app.request(`/api/digest?projectId=${projectId}&range=7d&now=${encodeURIComponent(NOW)}`);
    const body = await res.json() as any;
    const movedNumbers = body.moved.map((m: any) => m.issueNumber);
    expect(movedNumbers).toContain(3);
    expect(movedNumbers).toContain(4);
  });

  it("reports merged workspaces and agent sessions in the window", async () => {
    // Workspace for issue 2, closed (merged) 3h ago, with a successful session.
    const wsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: wsId,
      issueId: issue2Id,
      branch: "feature/ak-2-old",
      status: "closed",
      createdAt: hoursAgo(20),
      updatedAt: hoursAgo(3),
      closedAt: hoursAgo(3),
    });
    const sessId = randomUUID();
    await db.insert(schema.sessions).values({
      id: sessId,
      workspaceId: wsId,
      status: "stopped",
      startedAt: hoursAgo(4),
      endedAt: hoursAgo(3),
      exitCode: "0",
      stats: JSON.stringify({ success: true, durationMs: 60000, totalCostUsd: 0.42 }),
    });

    const res = await app.request(`/api/digest?projectId=${projectId}&range=24h&now=${encodeURIComponent(NOW)}`);
    const body = await res.json() as any;

    expect(body.headline.mergedCount).toBe(1);
    expect(body.merged[0].branch).toBe("feature/ak-2-old");

    expect(body.headline.sessionCount).toBe(1);
    expect(body.headline.sessionSuccessCount).toBe(1);
    expect(body.headline.totalCostUsd).toBeCloseTo(0.42, 5);
    expect(body.sessions[0].success).toBe(true);
  });
});
