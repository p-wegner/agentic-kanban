// @covers mcp-server.update.issue.node-sync [workflow,state-transition]
//
// Regression for #501. `update_issue(statusName:…)` wrote `statusId`/`statusChangedAt`
// as plain columns via a raw `db.update(issues).set(updates)` and never synced the
// workflow current-node — so a workflow-driven issue moved to Done through MCP kept
// `currentNodeId` on a NON-END node. Dependency resolution checks the end-node, so it
// silently treated the closed issue as still open and the workflow-node-divergence
// reconciler had to repair it after the fact (the #537 re-break class).
//
// The sibling `move_issue` already routed through `transitionIssueStatus`; this is the
// door that had drifted. The status-write ratchet proves the raw write is gone — this
// proves the SYNC actually happens, which the ratchet cannot see.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerUpdateIssue } from "../../tools/update-issue.js";
import { setupTool } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

/** Build (start, In Progress) → Done (end, Done). */
async function seedWorkflow(db: TestDb, projectId: string) {
  const now = new Date().toISOString();
  const templateId = randomUUID();
  await db.insert(schema.workflowTemplates).values({
    id: templateId, projectId, name: "Linear", isDefault: false, isBuiltin: false, createdAt: now, updatedAt: now,
  });
  const buildId = randomUUID();
  const doneId = randomUUID();
  await db.insert(schema.workflowNodes).values([
    { id: buildId, templateId, name: "Build", nodeType: "start", statusName: "In Progress", maxVisits: 0, posX: 0, posY: 0, sortOrder: 0, createdAt: now },
    { id: doneId, templateId, name: "Done", nodeType: "end", statusName: "Done", maxVisits: 0, posX: 0, posY: 0, sortOrder: 1, createdAt: now },
  ] as any);
  await db.insert(schema.workflowEdges).values([
    { id: randomUUID(), templateId, fromNodeId: buildId, toNodeId: doneId, condition: "manual", sortOrder: 0, createdAt: now },
  ] as any);
  return { templateId, buildId, doneId };
}

async function seedIssueOnNode(db: TestDb, projectId: string, statusId: string, nodeId: string, templateId: string) {
  const { id } = await seedIssue(db, projectId, statusId, { title: "Workflow ticket" });
  await db.update(schema.issues)
    .set({ currentNodeId: nodeId, workflowTemplateId: templateId })
    .where(eq(schema.issues.id, id));
  return id;
}

describe("update_issue syncs the workflow current-node with the status (#501)", () => {
  it("advances currentNodeId to the end node, not just statusId", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, buildId, doneId } = await seedWorkflow(db, projectId);
    const issueId = await seedIssueOnNode(db, projectId, statusIds["In Progress"], buildId, templateId);

    await invoke({ issueId, statusName: "Done" });

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["Done"]);
    // The assertion that fails on the pre-#501 code: the status moved but the node did not.
    expect(issue.currentNodeId).toBe(doneId);
    expect(issue.currentNodeId).not.toBe(buildId);
    expect(issue.statusChangedAt).toBeTruthy();
  });

  it("still applies the non-status fields alongside the status transition", async () => {
    // #501 split one write into two (plain columns, then the transition). This pins that
    // the split did not drop the other fields on the floor.
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, buildId } = await seedWorkflow(db, projectId);
    const issueId = await seedIssueOnNode(db, projectId, statusIds["In Progress"], buildId, templateId);

    await invoke({ issueId, statusName: "Done", title: "Renamed", priority: "high" });

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.title).toBe("Renamed");
    expect(issue.priority).toBe("high");
    expect(issue.statusId).toBe(statusIds["Done"]);
  });

  it("leaves currentNodeId alone when no status change is requested", async () => {
    const { invoke, db } = setupTool(registerUpdateIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, buildId } = await seedWorkflow(db, projectId);
    const issueId = await seedIssueOnNode(db, projectId, statusIds["In Progress"], buildId, templateId);

    await invoke({ issueId, description: "just a description edit" });

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.description).toBe("just a description edit");
    expect(issue.currentNodeId).toBe(buildId);
    expect(issue.statusId).toBe(statusIds["In Progress"]);
  });
});
