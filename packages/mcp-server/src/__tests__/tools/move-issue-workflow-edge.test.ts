// @covers mcp-server.move.issue.workflow-edge [workflow,state-transition,error]
//
// Guard under test: move-issue.ts:56 — when an issue sits on a workflow graph
// (its `currentNodeId` is set and the node has outgoing edges), move_issue may
// only advance the issue to a status reachable by one of those edges. An illegal
// jump is refused with code WORKFLOW_TRANSITION_INVALID and the list of valid
// next stages, and must NOT mutate the issue. A legal edge target proceeds.
//
// This sits beside the well-covered terminal-status guard (terminal-done-guard.test.ts)
// but is the orthogonal *edge-legality* check — symmetry gap, previously uncovered.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { registerMoveIssue } from "../../tools/move-issue.js";
import { setupTool } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

/**
 * Seed a minimal linear workflow on `projectId` and return its node ids.
 *
 *   Build (start, In Progress) ─▶ Review (normal, In Review) ─▶ Done (end, Done)
 *
 * Only Build→Review and Review→Done are legal edges; there is NO Build→Done edge,
 * so a Build-stage issue trying to jump straight to Done is an illegal transition.
 */
async function seedLinearWorkflow(db: TestDb, projectId: string) {
  const now = new Date().toISOString();
  const templateId = randomUUID();
  await db.insert(schema.workflowTemplates).values({
    id: templateId, projectId, name: "Linear", isDefault: false, isBuiltin: false, createdAt: now, updatedAt: now,
  });
  const buildId = randomUUID();
  const reviewId = randomUUID();
  const doneId = randomUUID();
  await db.insert(schema.workflowNodes).values([
    { id: buildId, templateId, name: "Build", nodeType: "start", statusName: "In Progress", maxVisits: 0, posX: 0, posY: 0, sortOrder: 0, createdAt: now },
    { id: reviewId, templateId, name: "Review", nodeType: "normal", statusName: "In Review", maxVisits: 0, posX: 0, posY: 0, sortOrder: 1, createdAt: now },
    { id: doneId, templateId, name: "Done", nodeType: "end", statusName: "Done", maxVisits: 0, posX: 0, posY: 0, sortOrder: 2, createdAt: now },
  ] as any);
  await db.insert(schema.workflowEdges).values([
    { id: randomUUID(), templateId, fromNodeId: buildId, toNodeId: reviewId, condition: "tests_pass", sortOrder: 0, createdAt: now },
    { id: randomUUID(), templateId, fromNodeId: reviewId, toNodeId: doneId, condition: "manual", sortOrder: 1, createdAt: now },
  ] as any);
  return { templateId, buildId, reviewId, doneId };
}

/** Seed an issue parked on the Build (start) node of the given template. */
async function seedIssueOnNode(
  db: TestDb,
  projectId: string,
  statusId: string,
  nodeId: string,
  templateId: string,
) {
  const { id } = await seedIssue(db, projectId, statusId, { title: "Workflow ticket" });
  await db.update(schema.issues)
    .set({ currentNodeId: nodeId, workflowTemplateId: templateId })
    .where(eq(schema.issues.id, id));
  return id;
}

describe("move_issue — workflow edge legality", () => {
  it("refuses an illegal jump (Build → Done) with WORKFLOW_TRANSITION_INVALID and mutates nothing", async () => {
    const { invoke, db, deps } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, buildId } = await seedLinearWorkflow(db, projectId);
    const issueId = await seedIssueOnNode(db, projectId, statusIds["In Progress"], buildId, templateId);

    // Build's only outgoing edge is to Review; Done is NOT reachable from Build.
    const result = await invoke({ issueId, statusName: "Done" });
    const parsed = JSON.parse(result.content[0].text);

    // Error code + actionable next-stage guidance (workflow + error dimensions).
    expect(parsed.code).toBe("WORKFLOW_TRANSITION_INVALID");
    expect(parsed.movedTo).toBeUndefined();
    expect(parsed.error).toMatch(/Review/); // the valid next stage is surfaced to the agent

    // No mutation: status and node unchanged, no board notification fired
    // (state-transition dimension — proves the refusal blocks the write, not just the response).
    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Progress"]); // Build-node status, untouched
    expect(issue.currentNodeId).toBe(buildId);
    expect(deps.notifyBoard).not.toHaveBeenCalled();
  });

  it("allows a legal edge target (Build → In Review) and advances the issue", async () => {
    const { invoke, db, deps } = setupTool(registerMoveIssue);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, buildId } = await seedLinearWorkflow(db, projectId);
    const issueId = await seedIssueOnNode(db, projectId, statusIds["In Progress"], buildId, templateId);

    // Review IS a legal next stage from Build — the move proceeds.
    const result = await invoke({ issueId, statusName: "In Review" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeUndefined();
    expect(parsed.code).toBeUndefined();
    expect(parsed.movedTo).toBe("In Review");

    // The board column actually advanced.
    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Review"]);
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_move_issue");
  });
});
