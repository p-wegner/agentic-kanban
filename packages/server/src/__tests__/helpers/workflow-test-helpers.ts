import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import type { TestDb } from "./test-db.js";

const NOW = "2026-05-30T09:00:00.000Z";

export async function seedProject(db: TestDb, name: string) {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name,
    repoPath: `/tmp/${name}`,
    repoName: name,
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  });

  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: NOW,
  });

  return { projectId, statusId };
}

export async function seedIssue(
  db: TestDb,
  projectId: string,
  statusId: string,
  issueNumber: number,
  title: string,
  extra?: Partial<typeof schema.issues.$inferInsert>,
) {
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
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  });
  return issueId;
}

export async function seedWorkspace(
  db: TestDb,
  issueId: string,
  branch: string,
  currentNodeId: string | null,
  workingDir?: string,
) {
  const workspaceId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch,
    workingDir: workingDir ?? null,
    status: "active",
    currentNodeId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return workspaceId;
}

/** Seed a minimal linear workflow: start → middle → end, with manual edges. */
export async function seedLinearWorkflow(
  db: TestDb,
  names: string[],
  statuses: string[] = ["In Progress", "In Progress", "Done"],
) {
  const templateId = randomUUID();
  const now = NOW;
  await db.insert(schema.workflowTemplates).values({
    id: templateId,
    projectId: null,
    name: "Test Workflow",
    isDefault: true,
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  });

  const nodeIds: string[] = [];
  const nodeValues = names.map((name, i) => {
    const id = randomUUID();
    nodeIds.push(id);
    return {
      id,
      templateId,
      name,
      nodeType: i === 0 ? "start" : i === names.length - 1 ? "end" : "normal",
      statusName: statuses[i] ?? "In Progress",
      sortOrder: i,
      createdAt: now,
    };
  });
  await db.insert(schema.workflowNodes).values(nodeValues as any);

  for (let i = 0; i < nodeIds.length - 1; i++) {
    await db.insert(schema.workflowEdges).values({
      id: randomUUID(),
      templateId,
      fromNodeId: nodeIds[i],
      toNodeId: nodeIds[i + 1],
      condition: "manual",
      sortOrder: i,
      createdAt: now,
    });
  }

  return { templateId, nodeIds };
}
