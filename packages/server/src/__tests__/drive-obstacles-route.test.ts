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

async function createProject(db: TestDb, name = "Driver Project") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
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

describe("Drive obstacles API", () => {
  it("records an obstacle via POST and reads it back via the queryable log", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);

    const postRes = await app.request(`/api/projects/${projectId}/drive-obstacles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "over_launch",
        severity: "critical",
        issueNumber: 7,
        summary: "Launched over WIP",
        details: { launched: 5 },
      }),
    });
    expect(postRes.status).toBe(201);
    const { id } = await postRes.json() as { id: string };
    expect(id).toBeTruthy();

    const listRes = await app.request(`/api/projects/${projectId}/drive-obstacles`);
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as Array<{
      id: string; kind: string; severity: string; issueNumber: number | null; summary: string; details: string | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id, kind: "over_launch", severity: "critical", issueNumber: 7, summary: "Launched over WIP" });
    expect(body[0].details).toBe(JSON.stringify({ launched: 5 }));
  });

  it("rejects an invalid kind with 400", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    const res = await app.request(`/api/projects/${projectId}/drive-obstacles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "made_up", summary: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing summary with 400", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    const res = await app.request(`/api/projects/${projectId}/drive-obstacles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "stall" }),
    });
    expect(res.status).toBe(400);
  });

  it("filters the log by kind and severity", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    await db.insert(schema.driveObstacles).values([
      { id: "o1", projectId, kind: "stall", severity: "warning", summary: "s1", detectedAt: new Date(Date.now() - 3000).toISOString() },
      { id: "o2", projectId, kind: "verify_gate_failure", severity: "critical", summary: "s2", detectedAt: new Date(Date.now() - 2000).toISOString() },
      { id: "o3", projectId, kind: "over_launch", severity: "warning", summary: "s3", detectedAt: new Date(Date.now() - 1000).toISOString() },
    ]);

    const byKind = await app.request(`/api/projects/${projectId}/drive-obstacles?kind=stall,over_launch`);
    const kindBody = await byKind.json() as Array<{ id: string }>;
    expect(kindBody.map((o) => o.id).sort()).toEqual(["o1", "o3"]);

    const bySeverity = await app.request(`/api/projects/${projectId}/drive-obstacles?severity=critical`);
    const sevBody = await bySeverity.json() as Array<{ id: string }>;
    expect(sevBody.map((o) => o.id)).toEqual(["o2"]);
  });

  it("returns a zero-filled per-kind summary for the dashboard", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    await db.insert(schema.driveObstacles).values([
      { id: "a", projectId, kind: "stall", severity: "warning", summary: "s1", detectedAt: new Date().toISOString() },
      { id: "b", projectId, kind: "stall", severity: "warning", summary: "s2", detectedAt: new Date().toISOString() },
      { id: "c", projectId, kind: "silent_merge_loss", severity: "critical", summary: "m1", detectedAt: new Date().toISOString() },
    ]);

    const res = await app.request(`/api/projects/${projectId}/drive-obstacles/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; byKind: Array<{ kind: string; count: number }> };
    expect(body.total).toBe(3);
    // Every taxonomy kind is present, zeroes included.
    expect(body.byKind).toHaveLength(6);
    const map = new Map(body.byKind.map((k) => [k.kind, k.count]));
    expect(map.get("stall")).toBe(2);
    expect(map.get("silent_merge_loss")).toBe(1);
    expect(map.get("over_launch")).toBe(0);
    expect(map.get("premature_cascade")).toBe(0);
  });

  it("scopes the log and summary to one project", async () => {
    const { app, db } = createTestApp();
    const a = await createProject(db, "A");
    const b = await createProject(db, "B");
    await db.insert(schema.driveObstacles).values([
      { id: "a1", projectId: a, kind: "stall", severity: "warning", summary: "a", detectedAt: new Date().toISOString() },
      { id: "b1", projectId: b, kind: "stall", severity: "warning", summary: "b", detectedAt: new Date().toISOString() },
    ]);
    const listRes = await app.request(`/api/projects/${a}/drive-obstacles`);
    const list = await listRes.json() as Array<{ id: string }>;
    expect(list.map((o) => o.id)).toEqual(["a1"]);
  });
});
