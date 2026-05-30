import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, projects, projectStatuses, workflowEdges, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { buildWorkspaceSummaryMap } from "../services/workspace-summary.service.js";

describe("workspace-summary.service", () => {
  it("includes stored code metrics in the board workspace summary", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const metrics = {
      computedAt: now,
      coverage: { linesPct: 84.5, covered: 169, total: 200, source: "coverage/coverage-summary.json" },
      lint: { errors: 1, warnings: 2, violations: 3, source: "eslint-report.json" },
      complexity: { average: 6.2, max: 14, files: 9, source: "heuristic" as const },
    };

    await db.insert(projects).values({
      id: projectId,
      name: "Metrics Project",
      repoPath: "/tmp/metrics-project",
      repoName: "metrics-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "Done",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 1,
      title: "Show metrics",
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/metrics",
      status: "closed",
      codeMetricsJson: JSON.stringify(metrics),
      codeMetricsComputedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    expect(summaryMap.get(issueId)?.main?.codeMetrics).toEqual(metrics);
  });

  it("includes workflow progress for the main workspace", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const templateId = randomUUID();
    const implementNodeId = randomUUID();
    const reviewNodeId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Workflow Project",
      repoPath: "/tmp/workflow-project",
      repoName: "workflow-project",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values({
      id: statusId,
      projectId,
      name: "In Progress",
      sortOrder: 0,
      isDefault: true,
      createdAt: now,
    });
    await db.insert(workflowTemplates).values({
      id: templateId,
      projectId,
      name: "Feature workflow",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflowNodes).values([
      {
        id: implementNodeId,
        templateId,
        name: "Implement",
        nodeType: "normal",
        statusName: "In Progress",
        sortOrder: 0,
        createdAt: now,
      },
      {
        id: reviewNodeId,
        templateId,
        name: "Review",
        nodeType: "normal",
        statusName: "In Review",
        sortOrder: 1,
        createdAt: now,
      },
    ]);
    await db.insert(workflowEdges).values({
      id: randomUUID(),
      templateId,
      fromNodeId: implementNodeId,
      toNodeId: reviewNodeId,
      condition: "manual",
      sortOrder: 0,
      createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 2,
      title: "Show workflow",
      statusId,
      projectId,
      workflowTemplateId: templateId,
      currentNodeId: implementNodeId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      issueId,
      branch: "feature/workflow",
      status: "idle",
      currentNodeId: implementNodeId,
      createdAt: now,
      updatedAt: now,
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    expect(summaryMap.get(issueId)?.main?.workflow).toEqual({
      currentNodeId: implementNodeId,
      currentNodeName: "Implement",
      currentNodeType: "normal",
      state: "waiting",
      nextStages: ["Review"],
    });
  });
});
