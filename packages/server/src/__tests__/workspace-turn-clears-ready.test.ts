/**
 * #1545: a delivered follow-up turn on a ready-for-merge workspace clears readyForMerge, so
 * auto-merge cannot pick the old (reviewed) commit while the builder is changing it. A turn
 * that is REFUSED (busy agent) leaves the flag alone.
 */
import { Hono } from "hono";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { stampWorkspaceReadyForMergeAt, getWorkspaceReadyForMergeAt } from "../repositories/workspace-ready-for-merge.repository.js";

type TestDb = ReturnType<typeof createTestDb>["db"];

async function seedReadyWorkspace(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID(), statusId = randomUUID(), issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([{ id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now }]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "t", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1-t", workingDir: "/repo", baseBranch: "master",
    isDirect: false, status: "idle", provider: "claude", readyForMerge: true, createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: randomUUID(), workspaceId, executor: "claude-code", status: "running", startedAt: now, triggerType: "chat",
  });
  await stampWorkspaceReadyForMergeAt(workspaceId, now, db as never);
  return workspaceId;
}

function mount(db: TestDb, sendTurn: ReturnType<typeof vi.fn>) {
  const sessionManager = {
    startSession: vi.fn(async () => "s"), stopSession: vi.fn(async () => true), sendTurn,
    subscribe: vi.fn(), unsubscribe: vi.fn(), wsRoute: vi.fn(() => () => {}),
  };
  const app = new Hono();
  app.route("/api/workspaces", createWorkspaceActionsRoute(() => sessionManager as never, db as never, {
    boardEvents: { broadcast: vi.fn(), broadcastActivity: vi.fn() } as never,
  }));
  return app;
}

const post = (app: Hono, id: string) =>
  app.request(`/api/workspaces/${id}/turn`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "fix it" }),
  });

describe("POST /api/workspaces/:id/turn clears readyForMerge (#1545)", () => {
  let db: TestDb;
  beforeEach(() => { ({ db } = createTestDb()); });

  it("clears the flag and the readySince stamp when the turn is delivered", async () => {
    const id = await seedReadyWorkspace(db);
    const res = await post(mount(db, vi.fn(() => ({ ok: true }))), id);
    expect(res.status).toBe(200);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    expect(ws.readyForMerge).toBe(false);
    expect(await getWorkspaceReadyForMergeAt(id, db as never)).toBeUndefined();
  });

  it("leaves the flag alone when the turn is refused (busy agent)", async () => {
    const id = await seedReadyWorkspace(db);
    const res = await post(mount(db, vi.fn(() => ({ ok: false, error: "busy" }))), id);
    expect(res.status).toBe(409);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    expect(ws.readyForMerge).toBe(true);
  });
});
