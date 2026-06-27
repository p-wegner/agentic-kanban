// @covers workspaces.turn.missing-content [error, api]
/**
 * HTTP-level coverage for the POST /api/workspaces/:id/turn content-validation guard.
 *
 * The turn endpoint takes `content` (NOT `message` — a recurring caller mistake).
 * A turn with a missing or empty `content` must be rejected with 400
 * `{ error: "content is required" }` BEFORE any session side effect. This is a
 * high-churn route and the guard (workspace-actions.ts: `if (!body.content) ... 400`)
 * had no direct test — a regression that dropped it would let an empty turn fall
 * through to `sendTurn`, push an empty prompt to the live agent, and (for a
 * running session) return 200 instead of the validation error.
 *
 * To prove the 400 is the CONTENT-validation 400 and NOT a "workspace/session not
 * found" 404, this seeds a REAL workspace with a RUNNING session and an injected
 * sessionManager whose sendTurn succeeds: a turn WITH content on that same
 * workspace returns 200, so the workspace plainly exists. The missing/empty-content
 * turns on that exact workspace still 400 — the guard, not a missing resource.
 *
 * Mutation note: if the `if (!body.content)` guard were removed, the empty turn
 * would reach the (succeeding) injected sendTurn and return 200 → this test goes RED.
 */

import { Hono } from "hono";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";

/** Seed a project + issue + a workspace that has a RUNNING session (resumable). */
async function seedRunningWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 42, title: "Turn issue", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-42-turn",
    workingDir: "/repo",
    baseBranch: "master", isDirect: false,
    status: "active",
    provider: "claude", createdAt: now, updatedAt: now,
  });
  // A running session makes the workspace resumable, so a valid turn takes the
  // `getSessionManager().sendTurn(...)` -> 200 path (no git, no agent spawn).
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "running",
    startedAt: now, triggerType: "chat",
  });

  return { workspaceId };
}

function mountRoute(db: ReturnType<typeof createTestDb>["db"], sendTurn: ReturnType<typeof vi.fn>) {
  const sessionManager = {
    startSession: vi.fn(async () => "session-x"),
    stopSession: vi.fn(async () => true),
    sendTurn,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    wsRoute: vi.fn(() => () => {}),
  };
  const boardEvents = { broadcast: vi.fn(), broadcastActivity: vi.fn() };
  const app = new Hono();
  app.route(
    "/api/workspaces",
    createWorkspaceActionsRoute(() => sessionManager as never, db as never, {
      boardEvents: boardEvents as never,
    }),
  );
  return app;
}

function postTurn(app: Hono, workspaceId: string, body: Record<string, unknown>) {
  return app.request(`/api/workspaces/${workspaceId}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/workspaces/:id/turn — content is required (400, not 404)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("rejects a turn with NO content field on an existing workspace with 400 — guard fires before sendTurn", async () => {
    const { workspaceId } = await seedRunningWorkspace(db);
    const sendTurn = vi.fn(() => ({ ok: true }));
    const app = mountRoute(db, sendTurn);

    const res = await postTurn(app, workspaceId, {});

    // error: the missing-content guard returns the specific validation 400.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "content is required" });
    // No turn side effect: the agent session was never asked to process a turn.
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("rejects a turn with EMPTY content with the same 400", async () => {
    const { workspaceId } = await seedRunningWorkspace(db);
    const sendTurn = vi.fn(() => ({ ok: true }));
    const app = mountRoute(db, sendTurn);

    const res = await postTurn(app, workspaceId, { content: "" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "content is required" });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("the `message` field (the common mistake) is NOT accepted as content → 400", async () => {
    const { workspaceId } = await seedRunningWorkspace(db);
    const sendTurn = vi.fn(() => ({ ok: true }));
    const app = mountRoute(db, sendTurn);

    // Caller sends `message` instead of `content` — endpoint requires `content`.
    const res = await postTurn(app, workspaceId, { message: "do the thing" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "content is required" });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("proves the 400 is content-validation, not 404: the SAME workspace accepts a turn WITH content (200)", async () => {
    const { workspaceId } = await seedRunningWorkspace(db);
    const sendTurn = vi.fn(() => ({ ok: true }));
    const app = mountRoute(db, sendTurn);

    const res = await postTurn(app, workspaceId, { content: "carry on" });

    // api: a well-formed turn on the running session is accepted.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn).toHaveBeenCalledWith(expect.any(String), "carry on");
  });
});
