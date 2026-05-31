import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createRoutes } from "../routes/index.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function createProject(database: TestDb, name = "Health Events Project") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await database.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `C:/tmp/${projectId}`,
    repoName: name.toLowerCase().replace(/\s+/g, "-"),
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("Board health events API", () => {
  it("returns recent project events with compact details", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    const otherProjectId = await createProject(db, "Other Project");

    await db.insert(schema.boardHealthEvents).values([
      {
        id: "event-old",
        projectId,
        cycleId: "cycle-1",
        eventType: "cycle_start",
        summary: "Monitor cycle started",
        details: JSON.stringify({ strategySource: "default", totals: { totalIssues: 3 } }),
        createdAt: "2026-05-31T10:00:00.000Z",
      },
      {
        id: "event-new",
        projectId,
        cycleId: "cycle-1",
        eventType: "error",
        summary: "Monitor cycle failed",
        details: JSON.stringify({ message: "network unavailable", retries: 2 }),
        createdAt: "2026-05-31T10:05:00.000Z",
      },
      {
        id: "event-other",
        projectId: otherProjectId,
        cycleId: "cycle-2",
        eventType: "action",
        summary: "Invoked tool: merge_workspace",
        details: JSON.stringify({ tool: "merge_workspace" }),
        createdAt: "2026-05-31T10:10:00.000Z",
      },
    ]);

    const res = await app.request(`/api/projects/${projectId}/board-health-events?limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{
      id: string;
      timestamp: string;
      level: string;
      type: string;
      summary: string;
      details: string | null;
    }>;

    expect(body.map((event) => event.id)).toEqual(["event-new", "event-old"]);
    expect(body[0]).toMatchObject({
      timestamp: "2026-05-31T10:05:00.000Z",
      level: "error",
      type: "error",
      summary: "Monitor cycle failed",
      details: "message: network unavailable, retries: 2",
    });
    expect(body[1].details).toBe("strategySource: default, totals: 1 fields");
  });
});
