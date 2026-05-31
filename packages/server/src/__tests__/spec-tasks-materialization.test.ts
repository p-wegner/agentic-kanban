import { describe, expect, it, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { applyMigrationsToClient, type TestDb } from "./helpers/test-db.js";
import { materializeSpecTasksForWorkspace, parseTasksArtifact } from "../services/spec-tasks-materialization.service.js";

const tempDirs: string[] = [];

function createFileTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "ak-spec-tasks-"));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  applyMigrationsToClient(client);
  return drizzle(client, { schema }) as TestDb;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function seedTasksWorkspace(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const backlogStatusId = randomUUID();
  const inProgressStatusId = randomUUID();
  const parentIssueId = randomUUID();
  const templateId = randomUUID();
  const tasksNodeId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Project",
    repoPath: "/tmp/project",
    repoName: "project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectStatuses).values([
    { id: backlogStatusId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(schema.workflowTemplates).values({
    id: templateId,
    name: "Spec",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workflowNodes).values({
    id: tasksNodeId,
    templateId,
    name: "Tasks",
    nodeType: "normal",
    statusName: "In Progress",
    sortOrder: 0,
    createdAt: now,
  });
  await db.insert(schema.issues).values({
    id: parentIssueId,
    issueNumber: 1,
    title: "Parent spec issue",
    priority: "medium",
    issueType: "feature",
    sortOrder: 0,
    statusId: inProgressStatusId,
    projectId,
    currentNodeId: tasksNodeId,
    workflowTemplateId: templateId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId: parentIssueId,
    branch: "feature/spec",
    status: "idle",
    currentNodeId: tasksNodeId,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, parentIssueId, workspaceId, backlogStatusId };
}

describe("parseTasksArtifact", () => {
  it("extracts task IDs, waves, priorities, and explicit dependencies", () => {
    const tasks = parseTasksArtifact(`# tasks

## Wave 1
- [ ] T001 [P] Build the shared parser priority: high
- [ ] T002 [P] Add API wiring

## Wave 2
- [ ] T003 Render children in UI - depends on: T001, T002
`);

    expect(tasks.map((task) => task.tempId)).toEqual(["T001", "T002", "T003"]);
    expect(tasks.map((task) => task.wave)).toEqual([1, 1, 2]);
    expect(tasks[0].priority).toBe("high");
    expect(tasks[2].explicitDependsOn).toEqual(["T001", "T002"]);
  });
});

describe("materializeSpecTasksForWorkspace", () => {
  it("creates backlog child issues with child_of links and wave dependency edges", async () => {
    const db = createFileTestDb();
    const { projectId, parentIssueId, workspaceId, backlogStatusId } = await seedTasksWorkspace(db);
    const now = new Date().toISOString();
    const boardEvents = { broadcast: vi.fn() } as any;

    await db.insert(schema.issueArtifacts).values({
      id: randomUUID(),
      issueId: parentIssueId,
      workspaceId,
      type: "text",
      mimeType: "text/markdown",
      caption: "phase-artifact:tasks",
      content: `# tasks

## Wave 1
- [ ] T001 [P] Build batch endpoint
- [ ] T002 [P] Add MCP wiring

## Wave 2
- [ ] T003 Verify workflow approval
`,
      createdAt: now,
    });

    const result = await materializeSpecTasksForWorkspace(workspaceId, db, { boardEvents });
    expect(result.skipped).toBe(false);
    expect(result.created).toHaveLength(3);

    const childRows = await db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.projectId, projectId));
    const children = childRows.filter((issue) => issue.id !== parentIssueId);
    expect(children).toHaveLength(3);
    expect(children.every((issue) => issue.statusId === backlogStatusId)).toBe(true);

    const childLinks = await db
      .select()
      .from(schema.issueDependencies)
      .where(and(eq(schema.issueDependencies.dependsOnId, parentIssueId), eq(schema.issueDependencies.type, "child_of")));
    expect(childLinks).toHaveLength(3);

    const waveEdges = await db
      .select()
      .from(schema.issueDependencies)
      .where(eq(schema.issueDependencies.type, "depends_on"));
    expect(waveEdges).toHaveLength(2);
    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "issue_created");
    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "dependency_added");
  });

  it("does not duplicate children when parent already has child links", async () => {
    const db = createFileTestDb();
    const { parentIssueId, workspaceId } = await seedTasksWorkspace(db);
    const childId = randomUUID();
    const now = new Date().toISOString();
    const parent = await db.select().from(schema.issues).where(eq(schema.issues.id, parentIssueId)).limit(1);

    await db.insert(schema.issues).values({
      id: childId,
      issueNumber: 2,
      title: "Existing child",
      priority: "medium",
      issueType: "task",
      sortOrder: 0,
      statusId: parent[0].statusId,
      projectId: parent[0].projectId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(),
      issueId: childId,
      dependsOnId: parentIssueId,
      type: "child_of",
      createdAt: now,
    });

    const result = await materializeSpecTasksForWorkspace(workspaceId, db);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("already-materialized");
  });
});
