// @covers workflow-engine.autoroute.condition [boundary]
//
// Boundary/safety-valve: when an auto-route (no explicit target) is requested and
// MULTIPLE outbound edges' conditions fire simultaneously, the engine must REFUSE
// (ambiguous → manual) rather than silently pick one. Routing must stay
// deterministic; picking the first firing edge would be nondeterministic relative
// to edge ordering. Single-fire and zero-fire are already covered in
// workflow-engine.test.ts — this asserts only the >=2 firing branch.
//
// Mutation check: if the refusal branch in transitions.ts (`firing.length === 1`
// else-refuse) were weakened to `target = firing[0]` (pick the first), this test
// goes RED — it would then report ok:true and advance to a node.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import {
  proposeTransition,
  initWorkspaceWorkflow,
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

async function seedIssue(db: TestDb, projectId: string, statusId: string, issueType = "task") {
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

describe("workflow-engine auto-route (multi-fire ambiguity)", () => {
  let db: TestDb;

  beforeEach(async () => {
    ({ db } = createTestDb());
    await ensureBuiltinSkills(db as any);
    await ensureBuiltinWorkflows(db as any);
  });

  it("REFUSES to auto-route when two outbound edge conditions fire at once", async () => {
    // Graph: Build --(tests_pass)--> Review
    //        Build --(diff_clean)--> Ship
    // With signals { testsPassed: true, diffFilesChanged: 0 } BOTH conditions
    // evaluate to "fire". An auto-route (no explicit target) is therefore ambiguous.
    const { projectId, statusIds } = await seedProject(db);
    const now = new Date().toISOString();
    const templateId = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id: templateId, projectId, name: "Ambiguous CI", isDefault: false, isBuiltin: false, createdAt: now, updatedAt: now,
    });
    const buildId = randomUUID();
    const reviewId = randomUUID();
    const shipId = randomUUID();
    await db.insert(schema.workflowNodes).values([
      { id: buildId, templateId, name: "Build", nodeType: "start", statusName: "In Progress", maxVisits: 0, posX: 0, posY: 0, sortOrder: 0, createdAt: now } as any,
      { id: reviewId, templateId, name: "Review", nodeType: "normal", statusName: "In Review", maxVisits: 0, posX: 0, posY: 0, sortOrder: 1, createdAt: now } as any,
      { id: shipId, templateId, name: "Ship", nodeType: "normal", statusName: "Done", maxVisits: 0, posX: 0, posY: 0, sortOrder: 2, createdAt: now } as any,
    ]);
    await db.insert(schema.workflowEdges).values([
      { id: randomUUID(), templateId, fromNodeId: buildId, toNodeId: reviewId, condition: "tests_pass", sortOrder: 0, createdAt: now } as any,
      { id: randomUUID(), templateId, fromNodeId: buildId, toNodeId: shipId, condition: "diff_clean", sortOrder: 1, createdAt: now } as any,
    ]);

    const issueId = await seedIssue(db, projectId, statusIds["Todo"], "task");
    await db.update(schema.issues).set({ workflowTemplateId: templateId }).where(eq(schema.issues.id, issueId));
    const wsId = await seedWorkspace(db, issueId);
    await initWorkspaceWorkflow(db as any, { workspaceId: wsId, issueId });

    // Two conditions fire simultaneously → engine must refuse, not pick one.
    const result = await proposeTransition(db as any, {
      workspaceId: wsId,
      signals: { testsPassed: true, diffFilesChanged: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.autoResolved).toBeFalsy();
    expect(result.toNode).toBeUndefined();
    // Refusal explains the ambiguity and names both candidate targets.
    expect(result.error).toContain("Multiple edges fired");
    expect(result.error).toContain("Review");
    expect(result.error).toContain("Ship");

    // The refusal must NOT mutate workflow state: the workspace stays on Build.
    const wsAfter = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(wsAfter.currentNodeId).toBe(buildId);
  });
});
