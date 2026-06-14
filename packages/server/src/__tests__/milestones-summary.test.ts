import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMilestonesRoute } from "../routes/milestones.js";

vi.mock("../services/butler-sdk.service.js", () => ({
  getButlerSession: vi.fn(),
  sendButlerTurn: vi.fn(),
}));

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/projects", createMilestonesRoute(db));
  });
}

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

describe("GET /api/projects/:id/milestones/summary", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let milestoneId: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    projectId = randomUUID();
    await database.insert(schema.projects).values({
      id: projectId,
      name: "Milestone Summary Project",
      repoPath: "/tmp/milestone-summary",
      repoName: "milestone-summary",
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

    const todoId = await status("Todo", 0);
    const doneId = await status("Done", 1);
    const cancelledId = await status("Cancelled", 2);

    milestoneId = randomUUID();
    await database.insert(schema.milestones).values({
      id: milestoneId,
      projectId,
      name: "Release 1",
      dueDate: null,
      createdAt: now,
    });
    await database.insert(schema.milestones).values({
      id: randomUUID(),
      projectId,
      name: "Empty Release",
      dueDate: null,
      createdAt: now,
    });

    async function issue(
      issueNumber: number,
      statusId: string,
      milestone: string | null,
      createdAt: string,
      statusChangedAt: string | null,
    ) {
      await database.insert(schema.issues).values({
        id: randomUUID(),
        issueNumber,
        title: `Issue ${issueNumber}`,
        statusId,
        projectId,
        milestoneId: milestone,
        createdAt,
        updatedAt: statusChangedAt ?? createdAt,
        statusChangedAt,
      });
    }

    await issue(1, todoId, milestoneId, daysAgo(20), null);
    await issue(2, doneId, milestoneId, daysAgo(20), daysAgo(3));
    await issue(3, cancelledId, milestoneId, daysAgo(20), daysAgo(2));
    await issue(4, todoId, null, daysAgo(20), null);
  });

  it("aggregates counts and burndown per milestone on the server", async () => {
    const res = await app.request(`/api/projects/${projectId}/milestones/summary?days=7`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    const release = body.find((m) => m.id === milestoneId);

    expect(release).toMatchObject({
      name: "Release 1",
      totalIssues: 3,
      openIssues: 1,
      closedIssues: 2,
      progressPercent: 67,
    });
    expect(release.burndown).toHaveLength(7);
    expect(release.burndown.at(-1).remaining).toBe(1);

    const empty = body.find((m) => m.name === "Empty Release");
    expect(empty).toMatchObject({
      totalIssues: 0,
      openIssues: 0,
      closedIssues: 0,
      progressPercent: 0,
    });
    expect(empty.burndown).toHaveLength(7);
  });
});
