// @covers workflow.nodeStatusDivergence.sweep [db, correctness]
//
// The DB half of #395/#397: the scan must FIND the eventhub shape (issue on an `end` node with a
// non-terminal status), and clearing the node must clear it on the WORKSPACE too — the board's
// column override reads `workspaces.current_node_id`, so a node cleared only on the issue would
// keep rendering in the stale column, which is the exact #381 symptom.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { listNodeDivergences, reconcileWorkflowNodeDivergence } from "../startup/workflow-node-divergence-reconciler.js";

async function seed(opts: {
  issueStatus: string;
  nodeType: string;
  nodeStatusName: string;
  workspaceStatus?: string;
  mergedAt?: string | null;
}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const templateId = randomUUID();
  const nodeId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, repoPath: `/tmp/${projectId}`, repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusIds: Record<string, string> = {};
  for (const [i, name] of ["In Progress", "In Review", "Done", "Cancelled"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(projectStatuses).values({ id, projectId, name, sortOrder: i, isDefault: i === 0, createdAt: now });
  }
  await db.insert(workflowTemplates).values({ id: templateId, projectId, name: "t", createdAt: now, updatedAt: now });
  await db.insert(workflowNodes).values({
    id: nodeId, templateId, name: opts.nodeStatusName, nodeType: opts.nodeType,
    statusName: opts.nodeStatusName, sortOrder: 0, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 97, title: "divergent", priority: "medium", sortOrder: 0,
    statusId: statusIds[opts.issueStatus], projectId, workflowTemplateId: templateId, currentNodeId: nodeId,
    createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-97-${workspaceId.slice(0, 8)}`, workingDir: null, baseBranch: "main",
    isDirect: false, status: opts.workspaceStatus ?? "ready_for_merge", mergedAt: opts.mergedAt ?? null,
    currentNodeId: nodeId, provider: "claude", createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId, nodeId, statusIds };
}

describe("listNodeDivergences (#395)", () => {
  it("finds the eventhub shape: end node, In Review status, live workspace", async () => {
    const { issueId } = await seed({ issueStatus: "In Review", nodeType: "end", nodeStatusName: "Done" });
    const rows = await listNodeDivergences(db);
    const found = rows.find((r) => r.issueId === issueId);
    expect(found).toBeTruthy();
    expect(found!.nodeType).toBe("end");
    expect(found!.hasLiveWorkspace).toBe(true);
    expect(found!.hasMergedWorkspace).toBe(false);
  });

  it("excludes an issue whose status is already Done — the ordinary finished state", async () => {
    const { issueId } = await seed({ issueStatus: "Done", nodeType: "end", nodeStatusName: "Done" });
    expect((await listNodeDivergences(db)).map((r) => r.issueId)).not.toContain(issueId);
  });

  it("reports a merged workspace even though it is closed", async () => {
    const { issueId } = await seed({
      issueStatus: "In Progress", nodeType: "start", nodeStatusName: "In Progress",
      workspaceStatus: "closed", mergedAt: new Date().toISOString(),
    });
    const found = (await listNodeDivergences(db)).find((r) => r.issueId === issueId);
    expect(found!.hasMergedWorkspace).toBe(true);
    expect(found!.hasLiveWorkspace).toBe(false);
  });
});

describe("reconcileWorkflowNodeDivergence (#395)", () => {
  it("clears the node on BOTH the issue and its live workspace", async () => {
    const { issueId, workspaceId } = await seed({ issueStatus: "In Review", nodeType: "end", nodeStatusName: "Done" });
    const result = await reconcileWorkflowNodeDivergence({ database: db, log: () => {} });
    expect(result.clearedNodes).toContain(issueId);
    const issueRow = await db.select({ nodeId: issues.currentNodeId }).from(issues).where(eq(issues.id, issueId));
    expect(issueRow[0].nodeId).toBeNull();
    // The board column override reads the WORKSPACE's node — clearing only the issue leaves the
    // stale column, which is #381's symptom all over again.
    const wsRow = await db.select({ nodeId: workspaces.currentNodeId }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRow[0].nodeId).toBeNull();
  });

  it("moves a merged, regressed issue to Done (#397)", async () => {
    const { issueId, statusIds } = await seed({
      issueStatus: "In Progress", nodeType: "start", nodeStatusName: "In Progress",
      workspaceStatus: "closed", mergedAt: new Date().toISOString(),
    });
    const result = await reconcileWorkflowNodeDivergence({ database: db, log: () => {} });
    expect(result.convergedToDone).toContain(issueId);
    const row = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(row[0].statusId).toBe(statusIds["Done"]);
  });

  it("is idempotent — a second sweep finds nothing left to do for the same issue", async () => {
    const { issueId } = await seed({ issueStatus: "In Review", nodeType: "end", nodeStatusName: "Done" });
    await reconcileWorkflowNodeDivergence({ database: db, log: () => {} });
    const second = await reconcileWorkflowNodeDivergence({ database: db, log: () => {} });
    expect(second.clearedNodes).not.toContain(issueId);
  });
});
