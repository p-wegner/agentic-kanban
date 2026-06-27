// @covers workspaces.plan.approve-reject [workflow,state-transition,api,error]
/**
 * HTTP-level coverage for the plan-mode approval gate (AK-924).
 *
 * The plan-mode RECONCILER and plan EXTRACTION are unit-tested
 * (plan-mode-reconciler.test.ts + session-lifecycle.test.ts park a workspace at
 * `awaiting-plan-approval`), but the approval GATE endpoints themselves — that the
 * user can read the pending plan, approve it to start implementation, or reject it
 * with feedback to re-plan — were never driven end-to-end. A regression in the route
 * wiring (status not flipped to `active`, pendingPlanPath not cleared, the
 * reject-without-feedback 400 guard removed, or no agent launched on approval) would
 * be invisible to the existing suites. This drives the real Hono route via
 * app.request().
 *
 * The ONE boundary the route does not let us avoid is the agent launch: the injected
 * sessionManager.startSession is a vi.fn() stub, so approval/rejection record a
 * launch deterministically without spawning a real agent. The plan endpoints touch
 * no git, so (unlike fix-and-merge-endpoint.test.ts) no git module mock is needed.
 */

import { Hono } from "hono";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";

const PLAN_TEXT = "# Plan\n\n1. Add the widget\n2. Wire it up\n3. Test it\n";

/** Seed a project + In-Progress issue + a plan-mode workspace parked at awaiting-plan-approval. */
async function seedPlanWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  workingDir: string,
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgressStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 924, title: "Plan-mode issue", priority: "medium",
    sortOrder: 0, statusId: inProgressStatusId, projectId, createdAt: now, updatedAt: now,
  });

  // Plan file the GET /plan handler reads (workingDir/PLAN.md).
  const planFilePath = join(workingDir, "PLAN.md");
  writeFileSync(planFilePath, PLAN_TEXT, "utf-8");

  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-924-plan",
    workingDir,
    baseBranch: "master", isDirect: false,
    status: "awaiting-plan-approval",
    planMode: true,
    pendingPlanPath: planFilePath,
    readyForMerge: false,
    provider: "claude", createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

function mountRoute(
  db: ReturnType<typeof createTestDb>["db"],
  startSession: ReturnType<typeof vi.fn>,
) {
  const sessionManager = {
    startSession,
    stopSession: vi.fn(async () => true),
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

describe("plan-mode approval gate — GET /plan, POST /implement-plan, POST /reject-plan", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let workingDir: string;

  beforeEach(() => {
    ({ db } = createTestDb());
    workingDir = mkdtempSync(join(tmpdir(), "ak-plan-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("GET /plan returns the pending plan text and path", async () => {
    const { workspaceId } = await seedPlanWorkspace(db, workingDir);
    const app = mountRoute(db, vi.fn());

    const res = await app.request(`/api/workspaces/${workspaceId}/plan`);

    // api: the gate exposes the plan awaiting the user's decision.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string | null; path: string | null };
    expect(body.content).toBe(PLAN_TEXT);
    expect(body.path).toBe(join(workingDir, "PLAN.md"));
  });

  it("POST /implement-plan approves the plan: launches an implement agent and flips awaiting-plan-approval -> active", async () => {
    const { workspaceId } = await seedPlanWorkspace(db, workingDir);
    const startSession = vi.fn(async () => "implement-session-1");
    const app = mountRoute(db, startSession);

    const res = await app.request(`/api/workspaces/${workspaceId}/implement-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // api: approval is accepted and reports the launched implementation session.
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ sessionId: "implement-session-1" });

    // workflow: implementation actually starts — an agent launches OUT of plan mode.
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        triggerType: "plan-implement",
        planMode: false,
      }),
    );

    // state-transition: the workspace leaves the approval gate and the pending plan is consumed.
    const [ws] = await db
      .select({ status: workspaces.status, pendingPlanPath: workspaces.pendingPlanPath })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("active");
    expect(ws.pendingPlanPath).toBeNull();
  });

  it("POST /reject-plan WITH feedback re-plans: launches a plan-mode agent and clears the gate", async () => {
    const { workspaceId } = await seedPlanWorkspace(db, workingDir);
    const startSession = vi.fn(async () => "replan-session-1");
    const app = mountRoute(db, startSession);

    const res = await app.request(`/api/workspaces/${workspaceId}/reject-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Please consider the auth path too." }),
    });

    // api: rejection with feedback is accepted and reports the new planning session.
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ sessionId: "replan-session-1" });

    // workflow: a re-planning agent launches and stays IN plan mode (the feedback drives a new plan).
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        triggerType: "plan-reject",
        planMode: true,
      }),
    );

    // state-transition: the gate is cleared (pendingPlanPath consumed) and the workspace is active again.
    const [ws] = await db
      .select({ status: workspaces.status, pendingPlanPath: workspaces.pendingPlanPath, planMode: workspaces.planMode })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("active");
    expect(ws.pendingPlanPath).toBeNull();
    expect(ws.planMode).toBe(true);
  });

  it("POST /reject-plan WITHOUT feedback is rejected (400) and launches no agent — feedback is mandatory for re-planning", async () => {
    const { workspaceId } = await seedPlanWorkspace(db, workingDir);
    const startSession = vi.fn(async () => "should-not-launch");
    const app = mountRoute(db, startSession);

    const res = await app.request(`/api/workspaces/${workspaceId}/reject-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // error: the missing-feedback guard fires before any side effect.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "feedback is required" });
    expect(startSession).not.toHaveBeenCalled();

    // No side effect: the workspace stays parked at the approval gate, plan still pending.
    const [ws] = await db
      .select({ status: workspaces.status, pendingPlanPath: workspaces.pendingPlanPath })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("awaiting-plan-approval");
    expect(ws.pendingPlanPath).toBe(join(workingDir, "PLAN.md"));
  });
});
