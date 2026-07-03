/**
 * #953 — unit tests for the two state-transition authorities:
 *
 *  - transitionIssueStatus (shared/lib/workflow-engine/status-transition.ts):
 *    writes statusId, stamps statusChangedAt, and syncs the workflow current-node
 *    (the divergence bug: raw writers skipping node sync re-broke the #537
 *    end-node dependency check).
 *
 *  - setWorkspaceStatus (repositories/workspace-status.repository.ts):
 *    enforces the terminal invariant — a workspace with status "closed" AND
 *    mergedAt set may not be revived without an explicit force+reason.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { transitionIssueStatus, initWorkspaceWorkflow } from "@agentic-kanban/shared/lib/workflow-engine";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { ensureBuiltinSkills } from "../db/seed.js";
import { ensureBuiltinWorkflows } from "../db/builtin-workflows.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";

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

async function seedIssue(db: TestDb, projectId: string, statusId: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id,
    issueNumber: 953,
    title: "Authority test issue",
    issueType: "bug",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedWorkspace(
  db: TestDb,
  issueId: string,
  overrides: Partial<typeof schema.workspaces.$inferInsert> = {},
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id,
    issueId,
    branch: "feature/test",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

describe("transitionIssueStatus (#953 issue authority)", () => {
  let db: TestDb;

  beforeEach(async () => {
    ({ db } = createTestDb());
    await ensureBuiltinSkills(db as any);
    await ensureBuiltinWorkflows(db as any);
  });

  it("writes statusId, stamps statusChangedAt, and syncs the workflow node", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);
    const wsId = await seedWorkspace(db, issueId);
    await initWorkspaceWorkflow(db as any, { workspaceId: wsId, issueId }); // start node = In Progress

    const now = "2026-07-02T10:00:00.000Z";
    await transitionIssueStatus(db as any, issueId, statusIds["In Review"], { now });

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["In Review"]);
    expect(issue.statusChangedAt).toBe(now);
    expect(issue.updatedAt).toBe(now);
    // The workflow current-node must follow the status (the #537 divergence class).
    const node = (await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.id, issue.currentNodeId!)))[0];
    expect(node.statusName).toBe("In Review");
  });

  it("still writes the status when the issue has no workflow (sync is a no-op)", async () => {
    const { projectId, statusIds } = await seedProject(db);
    const issueId = await seedIssue(db, projectId, statusIds["Todo"]);

    await transitionIssueStatus(db as any, issueId, statusIds["Done"]);

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.statusId).toBe(statusIds["Done"]);
    expect(issue.statusChangedAt).toBeTruthy();
  });
});

describe("setWorkspaceStatus (#953 workspace authority, terminal invariant)", () => {
  let db: TestDb;
  let issueId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    const { projectId, statusIds } = await seedProject(db);
    issueId = await seedIssue(db, projectId, statusIds["Done"]);
  });

  it("blocks reviving a closed+merged workspace (returns false, keeps closed)", async () => {
    const wsId = await seedWorkspace(db, issueId, {
      status: "closed",
      mergedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    for (const target of ["idle", "active"] as const) {
      const ok = await setWorkspaceStatus(db as any, wsId, target);
      expect(ok).toBe(false);
      const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
      expect(ws.status).toBe("closed");
    }
  });

  it("allows reviving with an explicit force+reason", async () => {
    const wsId = await seedWorkspace(db, issueId, {
      status: "closed",
      mergedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const ok = await setWorkspaceStatus(db as any, wsId, "idle", {
      force: { reason: "test: deliberate revive of a merged workspace" },
    });
    expect(ok).toBe(true);
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("idle");
  });

  it("allows reviving a closed workspace WITHOUT mergedAt (abandoned close is not terminal)", async () => {
    const wsId = await seedWorkspace(db, issueId, { status: "closed" });

    const ok = await setWorkspaceStatus(db as any, wsId, "idle");
    expect(ok).toBe(true);
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("idle");
  });

  it("writes status, updatedAt, and extra columns atomically", async () => {
    const wsId = await seedWorkspace(db, issueId, { status: "reviewing", readyForMerge: true, workingDir: "/wt" });
    const now = "2026-07-02T11:00:00.000Z";

    const ok = await setWorkspaceStatus(db as any, wsId, "closed", { now, set: { workingDir: null, readyForMerge: false } });
    expect(ok).toBe(true);
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("closed");
    expect(ws.updatedAt).toBe(now);
    expect(ws.workingDir).toBeNull();
    expect(ws.readyForMerge).toBe(false);
  });

  it("onlyIfCurrentStatus is a compare-and-set (skips when the status moved on)", async () => {
    const wsId = await seedWorkspace(db, issueId, { status: "active" });

    await setWorkspaceStatus(db as any, wsId, "idle", { onlyIfCurrentStatus: "fixing" });
    const ws = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws.status).toBe("active");

    await setWorkspaceStatus(db as any, wsId, "idle", { onlyIfCurrentStatus: "active" });
    const ws2 = (await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)))[0];
    expect(ws2.status).toBe("idle");
  });
});
