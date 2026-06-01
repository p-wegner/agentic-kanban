import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowsRoute } from "../routes/workflows.js";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";
import { eq } from "drizzle-orm";

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
  workingDir?: string,
) {
  const now = "2026-05-30T09:00:00.000Z";
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch,
    workingDir: workingDir ?? null,
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
    expect(analytics.durationTrends).toContainEqual({
      date: "2026-05-30",
      nodeId: buildNodeId,
      nodeName: "Build",
      avgDwellMs: 15 * 60 * 1000,
      samples: 1,
    });
    expect(analytics.funnel.find((node: any) => node.nodeId === buildNodeId)).toMatchObject({
      templateId,
      templateName: "Test Workflow",
      nodeName: "Build",
      entered: 2,
      advanced: 1,
      dropoff: 1,
      conversionRate: 50,
    });
    expect(analytics.burnDown).toContainEqual({
      date: "2026-05-30",
      started: 2,
      completed: 0,
      remaining: 2,
    });

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

describe("workflows route task approval", () => {
  it("syncs the issue status when transitioning from Implement to Review", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId: inProgressStatusId } = await seedProject(db, "implement-review-sync");
    const now = "2026-05-30T09:00:00.000Z";
    const inReviewStatusId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: inReviewStatusId,
      projectId,
      name: "In Review",
      sortOrder: 1,
      isDefault: false,
      createdAt: now,
    });

    const templateId = randomUUID();
    const implementNodeId = randomUUID();
    const reviewNodeId = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id: templateId,
      projectId: null,
      name: "Implement Review",
      isDefault: true,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.workflowNodes).values([
      { id: implementNodeId, templateId, name: "Implement", nodeType: "normal", statusName: "In Progress", sortOrder: 0, createdAt: now },
      { id: reviewNodeId, templateId, name: "Review", nodeType: "normal", statusName: "In Review", sortOrder: 1, createdAt: now },
    ] as any);
    await db.insert(schema.workflowEdges).values({
      id: randomUUID(),
      templateId,
      fromNodeId: implementNodeId,
      toNodeId: reviewNodeId,
      condition: "manual",
      sortOrder: 0,
      createdAt: now,
    });

    const issueId = await seedIssue(db, projectId, inProgressStatusId, 244, "Implement to Review");
    await db.update(schema.issues).set({ workflowTemplateId: templateId, currentNodeId: implementNodeId }).where(eq(schema.issues.id, issueId));
    const workspaceId = await seedWorkspace(db, issueId, "feature/implement-review", implementNodeId);

    const res = await app.request(`/api/workflows/workspaces/${workspaceId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toNodeName: "Review", summary: "ready for review" }),
    });

    expect(res.status).toBe(200);
    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(inReviewStatusId);
    expect(issue.currentNodeId).toBe(reviewNodeId);
  });

  it("writes the approved phase artifact into the workspace before advancing", async () => {
    const { app, db } = createTestApp();
    const worktreePath = mkdtempSync(join(tmpdir(), "ak-phase-artifact-"));
    try {
      const { projectId, statusId } = await seedProject(db, "phase-artifact-write");
      const now = "2026-05-30T09:00:00.000Z";
      const templateId = randomUUID();
      const specifyNodeId = randomUUID();
      const designNodeId = randomUUID();
      await db.insert(schema.workflowTemplates).values({
        id: templateId,
        projectId: null,
        name: "Spec",
        isDefault: true,
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(schema.workflowNodes).values([
        { id: specifyNodeId, templateId, name: "Specify", nodeType: "normal", statusName: "In Progress", sortOrder: 0, createdAt: now },
        { id: designNodeId, templateId, name: "Design", nodeType: "normal", statusName: "In Progress", sortOrder: 1, createdAt: now },
      ] as any);
      await db.insert(schema.workflowEdges).values({
        id: randomUUID(),
        templateId,
        fromNodeId: specifyNodeId,
        toNodeId: designNodeId,
        condition: "manual",
        sortOrder: 0,
        createdAt: now,
      });

      const issueId = await seedIssue(db, projectId, statusId, 7, "Persist Phase Artifacts!");
      await db.update(schema.issues).set({ workflowTemplateId: templateId, currentNodeId: specifyNodeId }).where(eq(schema.issues.id, issueId));
      const workspaceId = await seedWorkspace(db, issueId, "feature/spec", specifyNodeId, worktreePath);
      await db.insert(schema.issueArtifacts).values({
        id: randomUUID(),
        issueId,
        workspaceId,
        type: "text",
        mimeType: "text/markdown",
        caption: "phase-artifact:specify",
        content: "# spec\n\nApproved requirements.\n",
        createdAt: now,
      });

      const res = await app.request(`/api/workflows/workspaces/${workspaceId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toNodeId: designNodeId }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.phaseArtifact.relativePath).toBe("specs/7-persist-phase-artifacts/spec.md");
      expect(readFileSync(join(worktreePath, "specs", "7-persist-phase-artifacts", "spec.md"), "utf-8").trim()).toBe("# spec\n\nApproved requirements.");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("does not materialize task children when the requested transition is invalid", async () => {
    const { app, db } = createTestApp();
    const { projectId, statusId } = await seedProject(db, "task-transition-validation");
    const backlogStatusId = randomUUID();
    const now = "2026-05-30T09:00:00.000Z";
    await db.insert(schema.projectStatuses).values({
      id: backlogStatusId,
      projectId,
      name: "Backlog",
      sortOrder: -1,
      isDefault: false,
      createdAt: now,
    });

    const templateId = randomUUID();
    const tasksNodeId = randomUUID();
    const implementNodeId = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id: templateId,
      projectId: null,
      name: "Spec",
      isDefault: true,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.workflowNodes).values([
      { id: tasksNodeId, templateId, name: "Tasks", nodeType: "normal", statusName: "In Progress", sortOrder: 0, createdAt: now },
      { id: implementNodeId, templateId, name: "Implement", nodeType: "normal", statusName: "In Progress", sortOrder: 1, createdAt: now },
    ] as any);

    const issueId = await seedIssue(db, projectId, statusId, 1, "Parent spec issue");
    await db.update(schema.issues).set({ workflowTemplateId: templateId, currentNodeId: tasksNodeId }).where(eq(schema.issues.id, issueId));
    const workspaceId = await seedWorkspace(db, issueId, "feature/spec", tasksNodeId);
    await db.insert(schema.issueArtifacts).values({
      id: randomUUID(),
      issueId,
      workspaceId,
      type: "text",
      mimeType: "text/markdown",
      caption: "phase-artifact:tasks",
      content: "# tasks\n\n## Wave 1\n- [ ] T001 Build the thing\n",
      createdAt: now,
    });

    const res = await app.request(`/api/workflows/workspaces/${workspaceId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toNodeId: implementNodeId }),
    });

    expect(res.status).toBe(400);
    const projectIssues = await db.select().from(schema.issues).where(eq(schema.issues.projectId, projectId));
    expect(projectIssues).toHaveLength(1);
    const deps = await db.select().from(schema.issueDependencies);
    expect(deps).toHaveLength(0);
  });
});
