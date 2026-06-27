// @covers workflow-engine.advance.mcpProposeTransition [api,workflow,state-transition]
import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { initWorkspaceWorkflow } from "@agentic-kanban/shared/lib/workflow-engine";
import { registerProposeTransition } from "../../tools/propose-transition.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

// The tool calls notifyWorkflowAdvanced() on every successful transition, which
// in production POSTs to the running server's /api/internal/workflow-advanced.
// It is NOT part of injectable ToolDeps, so without this mock the tests would
// issue LIVE network calls (and could trigger real board orchestration) whenever
// a dev server is up. Mock it to a spy: no network leaves the process, and we
// can assert it fires only on success.
vi.mock("../../notify.js", () => ({
  notifyWorkflowAdvanced: vi.fn(),
  notifyBoard: vi.fn(),
}));
import { notifyWorkflowAdvanced } from "../../notify.js";

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Build a minimal CI-shaped workflow on `projectId` and return its node ids.
 *
 *   Build (start, In Progress)
 *     ├─ tests_pass ─▶ Review (normal, In Review) ─ manual ─▶ Done (end, Done)
 *     └─ tests_fail ─▶ Fix    (normal, In Progress)
 *
 * Mirrors the auto-route/gate fixtures in the server's workflow-engine.test.ts,
 * but is owned here so the MCP test asserts the tool's wrapper, not the engine.
 */
async function seedWorkflow(db: TestDb, projectId: string) {
  const now = new Date().toISOString();
  const templateId = randomUUID();
  await db.insert(schema.workflowTemplates).values({
    id: templateId, projectId, name: "CI", isDefault: false, isBuiltin: false, createdAt: now, updatedAt: now,
  });
  const buildId = randomUUID();
  const reviewId = randomUUID();
  const fixId = randomUUID();
  const doneId = randomUUID();
  await db.insert(schema.workflowNodes).values([
    { id: buildId, templateId, name: "Build", nodeType: "start", statusName: "In Progress", maxVisits: 0, posX: 0, posY: 0, sortOrder: 0, createdAt: now },
    { id: reviewId, templateId, name: "Review", nodeType: "normal", statusName: "In Review", maxVisits: 0, posX: 0, posY: 0, sortOrder: 1, createdAt: now },
    { id: fixId, templateId, name: "Fix", nodeType: "normal", statusName: "In Progress", maxVisits: 0, posX: 0, posY: 0, sortOrder: 2, createdAt: now },
    { id: doneId, templateId, name: "Done", nodeType: "end", statusName: "Done", maxVisits: 0, posX: 0, posY: 0, sortOrder: 3, createdAt: now },
  ] as any);
  await db.insert(schema.workflowEdges).values([
    { id: randomUUID(), templateId, fromNodeId: buildId, toNodeId: reviewId, condition: "tests_pass", sortOrder: 0, createdAt: now },
    { id: randomUUID(), templateId, fromNodeId: buildId, toNodeId: fixId, condition: "tests_fail", sortOrder: 1, createdAt: now },
    { id: randomUUID(), templateId, fromNodeId: reviewId, toNodeId: doneId, condition: "manual", sortOrder: 2, createdAt: now },
  ] as any);
  return { templateId, buildId, reviewId, fixId, doneId };
}

/** Seed an issue on the template + an active workspace placed on the start node. */
async function seedRunningWorkspace(
  db: TestDb,
  projectId: string,
  statusIds: Record<string, string>,
  templateId: string,
  workspaceId = randomUUID(),
) {
  const issue = await seedIssue(db, projectId, statusIds.Todo, { title: "Multi-stage ticket" });
  await db.update(schema.issues).set({ workflowTemplateId: templateId }).where(eq(schema.issues.id, issue.id));
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id: workspaceId, issueId: issue.id, branch: "feature/ci", status: "active", createdAt: now, updatedAt: now,
  });
  await initWorkspaceWorkflow(db as any, { workspaceId, issueId: issue.id });
  return { issueId: issue.id, workspaceId };
}

describe("propose_transition MCP tool", () => {
  it("advances along a legal edge and returns the shaped ok + next stages", async () => {
    const { invoke, db, deps } = setupTool(registerProposeTransition);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, reviewId } = await seedWorkflow(db, projectId);
    const { issueId, workspaceId } = await seedRunningWorkspace(db, projectId, statusIds, templateId);

    const data = parseResult(await invoke({
      workspaceId,
      toNodeName: "Review",
      testsPassed: true,
      summary: "implementation done",
    }));

    // Result-shaping contract unique to the MCP wrapper.
    expect(data.ok).toBe(true);
    expect(data.movedTo).toBe("Review");
    expect(data.status).toBe("In Review");
    expect(data.terminal).toBe(false);
    expect(data.nextStages).toEqual(["Done"]); // re-injected so the agent knows where to go next

    // Board column actually advanced (state-transition, not just a happy return).
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)))[0];
    expect(ws.currentNodeId).toBe(reviewId);
    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Review"]);

    // The UI is told to refresh for the owning project, and the main server is
    // told to run fork/join orchestration for THIS workspace.
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_propose_transition");
    expect(notifyWorkflowAdvanced).toHaveBeenCalledWith(workspaceId);
  });

  it("auto-routes from the agent's testsPassed signal when no target is named", async () => {
    const { invoke, db } = setupTool(registerProposeTransition);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, fixId } = await seedWorkflow(db, projectId);
    const { workspaceId } = await seedRunningWorkspace(db, projectId, statusIds, templateId);

    // No toNodeName: the tool computes signals from testsPassed and lets the
    // engine take the single firing edge (tests_fail → Fix).
    const data = parseResult(await invoke({ workspaceId, testsPassed: false }));

    expect(data.ok).toBe(true);
    expect(data.movedTo).toBe("Fix");
    expect(data.autoRouted).toBe(true);

    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)))[0];
    expect(ws.currentNodeId).toBe(fixId);
    expect(notifyWorkflowAdvanced).toHaveBeenCalledWith(workspaceId);
  });

  it("refuses an illegal transition with a reason and mutates nothing", async () => {
    const { invoke, db, deps } = setupTool(registerProposeTransition);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, buildId } = await seedWorkflow(db, projectId);
    const { issueId, workspaceId } = await seedRunningWorkspace(db, projectId, statusIds, templateId);

    // Done has no edge from the start node — teleporting is refused.
    const result = await invoke({ workspaceId, toNodeName: "Done" });

    // Structural: a refusal is NOT the success-shaped ok-JSON object. (The exact
    // wording lives in the shared engine, so we don't assert on its copy.)
    const text = result.content[0].text;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    expect((parsed as { ok?: boolean } | undefined)?.ok).not.toBe(true);

    // No advance, no status change, and no downstream side effects fired.
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)))[0];
    expect(ws.currentNodeId).toBe(buildId);
    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Progress"]); // start-node status, unchanged
    expect(deps.notifyBoard).not.toHaveBeenCalled();
    expect(notifyWorkflowAdvanced).not.toHaveBeenCalled();
  });

  it("resolves the active workspace from issueId alone, skipping closed ones", async () => {
    const { invoke, db } = setupTool(registerProposeTransition);
    const { projectId, statusIds } = await seedProject(db);
    const { templateId, reviewId } = await seedWorkflow(db, projectId);
    const activeWsId = randomUUID();
    const { issueId, workspaceId } = await seedRunningWorkspace(db, projectId, statusIds, templateId, activeWsId);

    // A stale CLOSED workspace on the same issue must NOT be the one resolved.
    // Give it a strictly LATER createdAt so that if the wrapper dropped the
    // status!=closed filter, the createdAt ordering would pick THIS one — making
    // the skip-closed behaviour unambiguous to catch.
    const later = new Date(Date.now() + 60_000).toISOString();
    const closedWsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: closedWsId, issueId, branch: "feature/old", status: "closed",
      currentNodeId: null, createdAt: later, updatedAt: later,
    });

    // No workspaceId — the wrapper must resolve the active workspace via issueId.
    const data = parseResult(await invoke({ issueId, toNodeName: "Review", testsPassed: true }));

    expect(data.ok).toBe(true);
    expect(data.movedTo).toBe("Review");
    // The ACTIVE workspace advanced (proves the right one was resolved)…
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)))[0];
    expect(ws.currentNodeId).toBe(reviewId);
    // …and orchestration was triggered for the active id, not the closed one.
    expect(notifyWorkflowAdvanced).toHaveBeenCalledWith(workspaceId);
    expect(notifyWorkflowAdvanced).not.toHaveBeenCalledWith(closedWsId);
  });

  it("returns guidance when neither workspaceId nor a resolvable issueId is given", async () => {
    const { invoke, db } = setupTool(registerProposeTransition);
    await seedProject(db);

    const result = await invoke({ issueId: randomUUID(), toNodeName: "Review" });
    // Stable token, not the full sentence: it must point the agent at workspaceId.
    expect(result.content[0].text).toMatch(/workspaceId/i);
    // Nothing advanced, so no orchestration call escaped.
    expect(notifyWorkflowAdvanced).not.toHaveBeenCalled();
  });
});
