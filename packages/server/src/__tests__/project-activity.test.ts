import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getProjectActivity } from "../services/project-activity.service.js";

let db: TestDb;
let client: ReturnType<typeof createTestDb>["client"];
let projectId: string;
let statusId: string;

beforeAll(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  client = testDb.client;

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test",
    repoName: "test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Done",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Test Issue",
    statusId,
    projectId,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: now,
    statusChangedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });
});

describe("getProjectActivity", () => {
  it("returns events for the project", async () => {
    const result = await getProjectActivity(projectId, db);
    expect(result.events.length).toBeGreaterThan(0);
    const created = result.events.find((e) => e.type === "issue_created");
    expect(created).toBeDefined();
  });

  it("returns empty events for unknown project", async () => {
    const result = await getProjectActivity(randomUUID(), db);
    expect(result.events).toHaveLength(0);
  });

  it("events are sorted newest-first", async () => {
    const result = await getProjectActivity(projectId, db);
    const timestamps = result.events.map((e) => e.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1] >= timestamps[i]).toBe(true);
    }
  });
});

describe("activity feed index coverage", () => {
  it("issues query uses idx_issues_project_id_created_at index", async () => {
    const result = await client.execute(
      `EXPLAIN QUERY PLAN SELECT id, issue_number, title, created_at, status_changed_at FROM issues WHERE project_id = 'x' ORDER BY created_at DESC`,
    );
    const plan = result.rows.map((r) => String(r[3] ?? r.detail ?? Object.values(r).join(" "))).join("\n");
    expect(plan.toLowerCase()).toContain("idx_issues_project_id_created_at");
  });

  it("workspaces query uses idx_workspaces_issue_id_created_at index", async () => {
    const result = await client.execute(
      `EXPLAIN QUERY PLAN SELECT id, issue_id, created_at, merged_at, closed_at FROM workspaces WHERE issue_id = 'x'`,
    );
    const plan = result.rows.map((r) => String(r[3] ?? r.detail ?? Object.values(r).join(" "))).join("\n");
    expect(plan.toLowerCase()).toContain("idx_workspaces_issue_id_created_at");
  });

  it("idx_sessions_workspace_id_started_at index exists", async () => {
    const result = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_workspace_id_started_at'`,
    );
    expect(result.rows.length).toBe(1);
  });
});
