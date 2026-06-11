import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createRoutes } from "../routes/index.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

describe("GET /api/issues/burndown", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let openStatusId: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "Burndown Project",
      repoPath: "/tmp/burndown",
      repoName: "burndown",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });

    async function status(name: string, sortOrder: number): Promise<string> {
      const id = randomUUID();
      await database.insert(schema.projectStatuses).values({
        id,
        projectId,
        name,
        sortOrder,
        isDefault: sortOrder === 0,
        createdAt: now,
      });
      return id;
    }

    openStatusId = await status("Todo", 0);
    const doneId = await status("Done", 1);
    const cancelledId = await status("Cancelled", 2);

    const longAgo = daysAgo(40); // created before the 30-day window
    const created = (issueNumber: number, statusId: string, closedAt: string | null) =>
      database.insert(schema.issues).values({
        id: randomUUID(),
        issueNumber,
        title: `Issue ${issueNumber}`,
        statusId,
        projectId,
        createdAt: longAgo,
        updatedAt: closedAt ?? longAgo,
        statusChangedAt: closedAt,
      });

    // A: still open — counts as remaining on every day of the window.
    await created(1, openStatusId, null);
    // B: Done 10 days ago — remaining until day-11, gone from day-10 onward.
    await created(2, doneId, daysAgo(10));
    // C: Cancelled 5 days ago — remaining until day-6, gone from day-5 onward.
    await created(3, cancelledId, daysAgo(5));
  });

  it("requires projectId", async () => {
    const res = await app.request("/api/issues/burndown?days=30");
    expect(res.status).toBe(400);
  });

  it("reconstructs remaining-open per day with terminal-status exclusion", async () => {
    const res = await app.request(`/api/issues/burndown?projectId=${projectId}&days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // One bucket per day in the trailing window.
    expect(body.buckets).toHaveLength(30);
    expect(body.buckets[0]).toHaveProperty("remaining");
    expect(body.buckets[0]).toHaveProperty("opened");
    expect(body.buckets[0]).toHaveProperty("closed");

    // All three issues existed before the window opened and none were closed yet → 3 remaining.
    expect(body.startCount).toBe(3);
    // Only the open issue remains today; the two closes (10d, 5d ago) removed the others,
    // and nothing was opened in-window, so 3 → 1 is only explained by the 2 closes.
    expect(body.endCount).toBe(1);
    expect(body.totalClosed).toBe(2);
    expect(body.totalOpened).toBe(0);

    // Remaining never exceeds the start count (issues age out only as they close).
    const peak = Math.max(...body.buckets.map((b: any) => b.remaining));
    expect(peak).toBe(3);
  });

  it("clamps days to [1, 365]", async () => {
    const huge = await app.request(`/api/issues/burndown?projectId=${projectId}&days=99999`);
    expect(huge.status).toBe(200);
    const body = await huge.json() as any;
    expect(body.buckets.length).toBeLessThanOrEqual(365);
  });

  it("returns an empty burndown for a project with no issues", async () => {
    const now = new Date().toISOString();
    const emptyProject = randomUUID();
    await database.insert(schema.projects).values({
      id: emptyProject,
      name: "Empty",
      repoPath: "/tmp/empty",
      repoName: "empty",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    const res = await app.request(`/api/issues/burndown?projectId=${emptyProject}&days=7`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.buckets).toHaveLength(7);
    expect(body.startCount).toBe(0);
    expect(body.endCount).toBe(0);
    expect(body.totalClosed).toBe(0);
  });
});
