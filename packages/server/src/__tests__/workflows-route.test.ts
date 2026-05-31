import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createWorkflowsRoute } from "../routes/workflows.js";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/workflows", createWorkflowsRoute(db));
  });
}

async function seedProject(db: TestDb, name: string) {
  const now = "2026-05-30T09:00:00.000Z";
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `/tmp/${name}`,
    repoName: name,
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  return { projectId, statusId };
}

async function seedIssue(db: TestDb, projectId: string, statusId: string, issueNumber: number, title: string) {
  const now = "2026-05-30T09:00:00.000Z";
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    projectId,
    statusId,
    issueNumber,
    title,
    priority: "medium",
    issueType: "task",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  return issueId;
}

async function seedWorkspace(
  db: TestDb,
  issueId: string,
  branch: string,
  currentNodeId: string,
) {
  const now = "2026-05-30T09:00:00.000Z";
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch,
    status: "active",
    currentNodeId,
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

describe("workflows route analytics", () => {
  it("lists workspace visits for a stage with issue metadata and dwell time", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seedProject(db, "workflows");
    const other = await seedProject(db, "other");

    const templateId = randomUUID();
    const startNodeId = randomUUID();
    const buildNodeId = randomUUID();
    const doneNodeId = randomUUID();
    const otherTemplateId = randomUUID();
    const otherTemplateNodeId = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id: templateId,
      projectId: null,
      name: "Test Workflow",
      isDefault: true,
      isBuiltin: false,
      createdAt: "2026-05-30T09:00:00.000Z",
      updatedAt: "2026-05-30T09:00:00.000Z",
    });
    await db.insert(schema.workflowTemplates).values({
      id: otherTemplateId,
      projectId: null,
      name: "Other Workflow",
      isDefault: false,
      isBuiltin: false,
      createdAt: "2026-05-30T09:00:00.000Z",
      updatedAt: "2026-05-30T09:00:00.000Z",
    });
    await db.insert(schema.workflowNodes).values([
      { id: startNodeId, templateId, name: "Start", nodeType: "start", statusName: "In Progress", sortOrder: 0, createdAt: "2026-05-30T09:00:00.000Z" },
      { id: buildNodeId, templateId, name: "Build", nodeType: "normal", statusName: "In Progress", sortOrder: 1, createdAt: "2026-05-30T09:00:00.000Z" },
      { id: doneNodeId, templateId, name: "Done", nodeType: "end", statusName: "Done", sortOrder: 2, createdAt: "2026-05-30T09:00:00.000Z" },
      { id: otherTemplateNodeId, templateId: otherTemplateId, name: "External", nodeType: "normal", statusName: "In Progress", sortOrder: 0, createdAt: "2026-05-30T09:00:00.000Z" },
    ] as any);

    const firstIssueId = await seedIssue(db, projectId, statusId, 11, "First issue");
    const firstWorkspaceId = await seedWorkspace(db, firstIssueId, "feature/first", otherTemplateNodeId);
    const secondIssueId = await seedIssue(db, projectId, statusId, 12, "Second issue");
    const secondWorkspaceId = await seedWorkspace(db, secondIssueId, "feature/second", buildNodeId);
    const otherIssueId = await seedIssue(db, other.projectId, other.statusId, 99, "Other project issue");
    const otherWorkspaceId = await seedWorkspace(db, otherIssueId, "feature/other", buildNodeId);

    await db.insert(schema.workflowTransitions).values([
      { id: randomUUID(), workspaceId: firstWorkspaceId, fromNodeId: null, toNodeId: startNodeId, createdAt: "2026-05-30T10:00:00.000Z", triggeredBy: "system" },
      { id: randomUUID(), workspaceId: firstWorkspaceId, fromNodeId: startNodeId, toNodeId: buildNodeId, createdAt: "2026-05-30T10:05:00.000Z", triggeredBy: "manual" },
      { id: randomUUID(), workspaceId: firstWorkspaceId, fromNodeId: buildNodeId, toNodeId: otherTemplateNodeId, createdAt: "2026-05-30T10:20:00.000Z", triggeredBy: "manual" },
      { id: randomUUID(), workspaceId: secondWorkspaceId, fromNodeId: null, toNodeId: startNodeId, createdAt: "2026-05-30T11:00:00.000Z", triggeredBy: "system" },
      { id: randomUUID(), workspaceId: secondWorkspaceId, fromNodeId: startNodeId, toNodeId: buildNodeId, createdAt: "2026-05-30T11:10:00.000Z", triggeredBy: "manual" },
      { id: randomUUID(), workspaceId: otherWorkspaceId, fromNodeId: null, toNodeId: buildNodeId, createdAt: "2026-05-30T12:00:00.000Z", triggeredBy: "system" },
    ]);

    const analyticsRes = await app.request(`/api/workflows/analytics?projectId=${projectId}`);
    expect(analyticsRes.status).toBe(200);
    const analytics = await analyticsRes.json() as any;
    expect(analytics.nodes.find((node: any) => node.nodeId === buildNodeId)?.templateId).toBe(templateId);

    const res = await app.request(
      `/api/workflows/analytics/${templateId}/${buildNodeId}/workspaces?projectId=${projectId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.nodeName).toBe("Build");
    expect(body.visits).toHaveLength(2);
    expect(body.visits.map((visit: any) => visit.workspaceId)).toEqual([secondWorkspaceId, firstWorkspaceId]);
    expect(body.visits[0]).toMatchObject({
      workspaceName: "feature/second",
      issueId: secondIssueId,
      issueNumber: 12,
      issueTitle: "Second issue",
      enteredAt: "2026-05-30T11:10:00.000Z",
      dwellMs: null,
      isCurrent: true,
    });
    expect(body.visits[1]).toMatchObject({
      workspaceName: "feature/first",
      issueId: firstIssueId,
      issueNumber: 11,
      issueTitle: "First issue",
      enteredAt: "2026-05-30T10:05:00.000Z",
      dwellMs: 15 * 60 * 1000,
      isCurrent: false,
    });
  });
});
