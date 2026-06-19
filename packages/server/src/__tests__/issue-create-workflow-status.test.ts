import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { TestDb } from "./helpers/test-db.js";
import { createIssueService } from "../services/issue.service.js";

const NOW = "2026-06-19T09:00:00.000Z";

/**
 * Regression: creating an issue with a workflow template must honor the status
 * the issue is created in (the column whose "+" the user clicked). Previously
 * the workflow's start node — whose status is usually "In Progress" — overrode
 * the chosen column, so a "Todo" quick-add silently landed in "In Progress".
 */
async function seed(db: TestDb) {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "wf-status", repoPath: "/tmp/wf-status", repoName: "wf-status",
    defaultBranch: "main", createdAt: NOW, updatedAt: NOW,
  });

  const statusIds: Record<string, string> = {};
  const names = ["Todo", "In Progress", "In Review", "Done"];
  for (let i = 0; i < names.length; i++) {
    const id = randomUUID();
    statusIds[names[i]] = id;
    await db.insert(schema.projectStatuses).values({
      id, projectId, name: names[i], sortOrder: i, isDefault: names[i] === "Todo", createdAt: NOW,
    });
  }

  // Global builtin-style template whose start node maps to "In Progress".
  const templateId = randomUUID();
  await db.insert(schema.workflowTemplates).values({
    id: templateId, projectId: null, name: "Simple", isDefault: true, isBuiltin: true,
    createdAt: NOW, updatedAt: NOW,
  });
  const startNodeId = randomUUID();
  const reviewNodeId = randomUUID();
  await db.insert(schema.workflowNodes).values([
    { id: startNodeId, templateId, name: "Implement", nodeType: "start", statusName: "In Progress", sortOrder: 0, createdAt: NOW },
    { id: reviewNodeId, templateId, name: "Review", nodeType: "normal", statusName: "In Review", sortOrder: 1, createdAt: NOW },
  ] as any);

  return { projectId, statusIds, templateId, startNodeId, reviewNodeId };
}

describe("createIssue — workflow initial status", () => {
  it("keeps the issue in the created column ('Todo'), not the workflow start node's status", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds, templateId } = await seed(db);
    const service = createIssueService({ database: db });

    const created = await service.createIssue({
      projectId,
      title: "Created in Todo",
      statusId: statusIds["Todo"],
      workflowTemplateId: templateId,
    });

    const row = (await db.select().from(schema.issues).where(eq(schema.issues.id, created.id)))[0];
    expect(row.statusId).toBe(statusIds["Todo"]);
    // "Todo" maps to no workflow node, so the workflow isn't active yet.
    expect(row.currentNodeId).toBeNull();
    expect(row.workflowTemplateId).toBe(templateId);
  });

  it("aligns currentNodeId to the workflow node when created directly in a mapped status", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds, templateId, startNodeId } = await seed(db);
    const service = createIssueService({ database: db });

    const created = await service.createIssue({
      projectId,
      title: "Created in In Progress",
      statusId: statusIds["In Progress"],
      workflowTemplateId: templateId,
    });

    const row = (await db.select().from(schema.issues).where(eq(schema.issues.id, created.id)))[0];
    expect(row.statusId).toBe(statusIds["In Progress"]);
    expect(row.currentNodeId).toBe(startNodeId);
  });

  it("rejects a workflow template that does not belong to the project", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seed(db);
    const service = createIssueService({ database: db });

    await expect(
      service.createIssue({
        projectId,
        title: "Bad template",
        statusId: statusIds["Todo"],
        workflowTemplateId: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});
