import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import {
  resolveTemplateForIssue,
  initWorkspaceWorkflow,
  proposeTransition,
  countNodeVisits,
  buildTransitionBlock,
  getStartNode,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { ensureBuiltinSkills } from "../db/seed.js";
import { ensureBuiltinWorkflows } from "../db/builtin-workflows.js";

async function seedProject(db: TestDb) {
  const projectId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/tmp/x",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  } as any);
  const statusNames = ["Todo", "In Progress", "In Review", "Done"];
  const statusIds: Record<string, string> = {};
  let sort = 0;
  for (const name of statusNames) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(schema.projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder: sort++,
      isDefault: name === "Todo",
      createdAt: now,
    });
  }
  return { projectId, statusIds };
}

async function seedIssue(db: TestDb, projectId: string, statusId: string, issueType = "bug") {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id,
    issueNumber: 1,
    title: "Test issue",
    issueType,
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedWorkspace(db: TestDb, issueId: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id,
    issueId,
    branch: "feature/test",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("workflow-engine", () => {
  let db: TestDb;

  beforeEach(async () => {
    ({ db } = createTestDb());
    await ensureBuiltinSkills(db as any);
    await ensureBuiltinWorkflows(db as any);
  });

  it("routes a bug issue to the Simple Bug template", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"], "bug");
    const templateId = await resolveTemplateForIssue(db as any, { projectId, issueType: "bug" });
    expect(templateId).toBeTruthy();
    const tpl = await db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, templateId!));
    expect(tpl[0].builtinKey).toBe("simple-bug");
  });

  it("falls back to Simple Ticket for an unmapped type", async () => {
    const { projectId } = await seedProject(db);
    const templateId = await resolveTemplateForIssue(db as any, { projectId, issueType: "chore" });
    const tpl = await db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, templateId!));
    expect(tpl[0].builtinKey).toBe("simple-ticket");
  });

  it("initialises a workspace on the start node and syncs status", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"], "bug");
    const wsId = await seedWorkspace(db, issueId);

    const init = await initWorkspaceWorkflow(db as any, { workspaceId: wsId, issueId });
    expect(init).toBeTruthy();
    expect(init!.node.nodeType).toBe("start");

    const issue = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId));
    expect(issue[0].currentNodeId).toBe(init!.node.id);
    // start node maps to "In Progress"
    expect(issue[0].statusId).toBe(statusIds["In Progress"]);
  });

  it("advances along a valid edge and syncs the derived status", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"], "bug");
    const wsId = await seedWorkspace(db, issueId);
    await initWorkspaceWorkflow(db as any, { workspaceId: wsId, issueId });

    const result = await proposeTransition(db as any, {
      workspaceId: wsId,
      toNodeName: "Review",
      summary: "fix done",
    });
    expect(result.ok).toBe(true);
    expect(result.toNode?.name).toBe("Review");

    const issue = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId));
    expect(issue[0].statusId).toBe(statusIds["In Review"]);
  });

  it("rejects an invalid transition", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"], "bug");
    const wsId = await seedWorkspace(db, issueId);
    await initWorkspaceWorkflow(db as any, { workspaceId: wsId, issueId });

    const result = await proposeTransition(db as any, {
      workspaceId: wsId,
      toNodeName: "Done", // not directly reachable from start in simple-bug
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No valid transition");
  });

  it("enforces maxVisits as a cycle guard", async () => {
    // Build a tiny template with a self-loop and maxVisits=1.
    const { projectId, statusIds } = await seedProject(db);
    const now = new Date().toISOString();
    const templateId = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id: templateId,
      projectId,
      name: "Looper",
      isDefault: false,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    const startId = randomUUID();
    const loopId = randomUUID();
    await db.insert(schema.workflowNodes).values([
      { id: startId, templateId, name: "Start", nodeType: "start", statusName: "In Progress", maxVisits: 0, posX: 0, posY: 0, sortOrder: 0, createdAt: now } as any,
      { id: loopId, templateId, name: "Loop", nodeType: "normal", statusName: "In Progress", maxVisits: 1, posX: 0, posY: 0, sortOrder: 1, createdAt: now } as any,
    ]);
    await db.insert(schema.workflowEdges).values([
      { id: randomUUID(), templateId, fromNodeId: startId, toNodeId: loopId, condition: "manual", sortOrder: 0, createdAt: now } as any,
      { id: randomUUID(), templateId, fromNodeId: loopId, toNodeId: loopId, condition: "manual", sortOrder: 1, createdAt: now } as any,
    ]);

    const issueId = await seedIssue(db, projectId, statusIds["Todo"], "task");
    await db.update(schema.issues).set({ workflowTemplateId: templateId }).where(eq(schema.issues.id, issueId));
    const wsId = await seedWorkspace(db, issueId);
    await initWorkspaceWorkflow(db as any, { workspaceId: wsId, issueId });

    // start -> loop (visit 1, allowed)
    const first = await proposeTransition(db as any, { workspaceId: wsId, toNodeName: "Loop" });
    expect(first.ok).toBe(true);
    expect(await countNodeVisits(db as any, wsId, loopId)).toBe(1);

    // loop -> loop again would be visit 2, over the budget of 1
    const second = await proposeTransition(db as any, { workspaceId: wsId, toNodeName: "Loop" });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("visit budget");
  });

  it("builds a transition block embedding the workspace id", async () => {
    const { projectId } = await seedProject(db);
    const templateId = await resolveTemplateForIssue(db as any, { projectId, issueType: "bug" });
    const node = await getStartNode(db as any, templateId!);
    const block = buildTransitionBlock(node!, [
      { edgeId: "e", toNodeId: "n", toNodeName: "Review", toStatusName: "In Review", label: "done", condition: "manual" },
    ], "ws-123");
    expect(block).toContain("propose_transition");
    expect(block).toContain("ws-123");
    expect(block).toContain("Review");
  });
});
