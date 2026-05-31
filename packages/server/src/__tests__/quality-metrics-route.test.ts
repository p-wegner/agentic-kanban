import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { createRoutes } from "../routes/index.js";
import { createTestApp as createHarness } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return createHarness((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

async function seedProject(db: TestDb) {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "quality-route-project",
    repoPath: "/tmp/quality-route-project",
    repoName: "quality-route-project",
    defaultBranch: "main",
  });
  return projectId;
}

describe("quality metrics routes", () => {
  it("records and lists project quality metrics through registered /api routes", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);

    const post = await app.request(`/api/projects/${projectId}/quality-metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collectedAt: "2026-05-30T12:00:00.000Z",
        commitSha: "abc123",
        metrics: [
          { metricKey: "coverage.lines", value: 84.2, unit: "percent" },
          { metricKey: "lint.errors", value: 0, unit: "count" },
        ],
      }),
    });
    expect(post.status).toBe(201);
    await expect(post.json()).resolves.toMatchObject({ inserted: 2 });

    const list = await app.request(`/api/projects/${projectId}/quality-metrics`);
    expect(list.status).toBe(200);
    const body = await list.json() as any;
    expect(body.latest.map((metric: any) => [metric.metricKey, metric.value])).toEqual([
      ["coverage.lines", 84.2],
      ["lint.errors", 0],
    ]);
    expect(body.trend).toHaveLength(2);

    const latest = await app.request(`/api/projects/${projectId}/quality-metrics/latest`);
    expect(latest.status).toBe(200);
    const latestBody = await latest.json() as any;
    expect(latestBody.latest).toHaveLength(2);
    expect(latestBody.trend).toEqual([]);
  });

  it("returns validation errors from the service", async () => {
    const { app, db } = createTestApp();
    const projectId = await seedProject(db);

    const res = await app.request(`/api/projects/${projectId}/quality-metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metrics: [] }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "metrics must be a non-empty array" });
  });
});
