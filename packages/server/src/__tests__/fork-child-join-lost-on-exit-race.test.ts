/**
 * Regression coverage for #1000: a fork child that successfully calls
 * `propose_transition` onto its parallel-join node (agent-triggered, work done)
 * can still have its session classified as a provider usage-limit / rate-limit
 * exit (e.g. a fast codex CLI non-zero exit right after the tool call). Because
 * the cross-process join notify (`notifyWorkflowAdvanced`, fire-and-forget HTTP,
 * no delivery guarantee — see packages/mcp-server/src/notify.ts) races the
 * in-process session-exit handling, `handleChildJoined` can simply never run for
 * that transition: the child is left with `forkStatus` stuck at "running" and
 * `status` flipped to "blocked", even though `currentNodeId` already equals its
 * recorded `forkJoinNodeId`. Previously nothing reconciled that state until the
 * 30-minute `CHILD_TIMEOUT` fired `cancelOverdueChild`, which wrongly marked the
 * (actually-finished) child "cancelled".
 *
 * These tests exercise `createWorkflowEngine`'s `reconcileForkChildOnExit` hook
 * (wired from `createWorkflowForkService().reconcileJoinedForkChild` in
 * server-start.ts) directly against `handleUsageLimitExit`'s blocked-write path.
 */

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("../services/agent-settings.service.js", () => ({
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));
vi.mock("../services/codex-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/codex-rate-limit.js")>()),
  isCodexUsageLimitStats: vi.fn((stats: string | null | undefined) => !!stats?.includes("codex-limit")),
}));
vi.mock("../services/claude-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/claude-rate-limit.js")>()),
  isClaudeUsageLimitStats: vi.fn(() => false),
}));

const rotateCodexLicense = vi.fn();
vi.mock("../services/codex-license-ring.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/codex-license-ring.js")>()),
  rotateCodexLicense: (...args: unknown[]) => rotateCodexLicense(...args),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, sessions, workspaces, workflowNodes } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import { createWorkflowForkService } from "../services/workflow-fork.service.js";

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}
function makeSessionManager() {
  return { startSession: vi.fn(async () => randomUUID()), stopSession: vi.fn(async () => {}) };
}

/**
 * Seed a fork PARENT + a single fork CHILD that is already sitting on its join
 * node (as `proposeTransition`/`placeWorkspaceOnNode` would have left it after a
 * successful `propose_transition` call), with a rate-limited session recorded
 * against the child.
 */
async function seedForkChildAlreadyOnJoinNode(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const issueId = randomUUID();
  const parentId = randomUUID();
  const childId = randomUUID();
  const sessionId = randomUUID();
  const forkNodeId = randomUUID();
  const joinNodeId = randomUUID();
  const entryNodeId = randomUUID();
  const templateId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 0, isDefault: true, createdAt: now },
  ]);
  await db.insert(schema.workflowTemplates).values({
    id: templateId, name: "Test template", projectId: null, createdAt: now, updatedAt: now,
  });
  await db.insert(workflowNodes).values([
    { id: forkNodeId, templateId, name: "Split", nodeType: "parallel-fork", sortOrder: 0, maxVisits: 0, createdAt: now },
    { id: entryNodeId, templateId, name: "Codex Plan", nodeType: "normal", sortOrder: 1, maxVisits: 0, createdAt: now },
    { id: joinNodeId, templateId, name: "Consolidate", nodeType: "parallel-join", statusName: "In Review", sortOrder: 2, maxVisits: 0, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 996, title: "multi-harness-plan-review", priority: "medium", sortOrder: 0,
    description: "Fork/join demo.", statusId: inReviewStatusId, projectId, workflowTemplateId: templateId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: parentId, issueId, branch: "feature/ak-996", workingDir: "/repo/.worktrees/ak-996",
    baseBranch: "master", isDirect: false, status: "active", readyForMerge: false,
    currentNodeId: forkNodeId, createdAt: now, updatedAt: now,
  });
  // The child is ALREADY on the join node — exactly what proposeTransition leaves
  // behind after a successful agent-triggered propose_transition call — but its
  // forkStatus was never flipped because the join notify never landed.
  await db.insert(workspaces).values({
    id: childId, issueId, branch: "feature/ak-996__fork-codex-plan",
    workingDir: "/repo/.worktrees/ak-996__fork-codex-plan", baseBranch: "feature/ak-996",
    isDirect: false, status: "active", readyForMerge: false, provider: "codex",
    currentNodeId: joinNodeId, parentWorkspaceId: parentId, forkNodeId, forkJoinNodeId: joinNodeId,
    forkStatus: "running", createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId: childId, status: "stopped",
    stats: JSON.stringify({ marker: "codex-limit", retryAfter: "2026-06-20T00:00:00.000Z" }),
    startedAt: now,
  });

  return { projectId, issueId, parentId, childId, sessionId, joinNodeId };
}

describe("#1000: fork child join lost on session-exit classifier race", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    rotateCodexLicense.mockReset();
  });

  it("reconciles a fork child already on its join node instead of leaving it blocked forever", async () => {
    const { childId, joinNodeId } = await seedForkChildAlreadyOnJoinNode(db);
    // The ring has nothing to rotate to — the exact "left blocked (no ring configured)" case from the ticket.
    rotateCodexLicense.mockResolvedValue({ rotated: false, fromProfile: "ki14", reason: "no ring configured" });
    const sessionManager = makeSessionManager();
    const forkService = createWorkflowForkService({
      database: db as never,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      reconcileForkChildOnExit: (workspaceId) => forkService.reconcileJoinedForkChild(workspaceId),
      database: db as never,
    });

    const [{ id: sessionId }] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, childId));

    await runWorkflowOnExit(childId, sessionId, 1);

    const [child] = await db.select().from(workspaces).where(eq(workspaces.id, childId));
    // The child must be JOINED, not stuck blocked/running.
    expect(child.forkStatus).toBe("joined");
    expect(child.status).toBe("closed");
    expect(child.currentNodeId).toBe(joinNodeId);
  });

  it("still leaves a genuinely rate-limited, NOT-yet-joined child blocked (no false-positive reconcile)", async () => {
    const { childId } = await seedForkChildAlreadyOnJoinNode(db);
    // Move the child OFF the join node — still mid-flight, not actually done.
    const [child] = await db.select().from(workspaces).where(eq(workspaces.id, childId));
    await db.update(workspaces).set({ currentNodeId: child.forkNodeId }).where(eq(workspaces.id, childId));

    rotateCodexLicense.mockResolvedValue({ rotated: false, fromProfile: "ki14", reason: "no ring configured" });
    const sessionManager = makeSessionManager();
    const forkService = createWorkflowForkService({
      database: db as never,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      reconcileForkChildOnExit: (workspaceId) => forkService.reconcileJoinedForkChild(workspaceId),
      database: db as never,
    });

    const [{ id: sessionId }] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, childId));
    await runWorkflowOnExit(childId, sessionId, 1);

    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, childId));
    expect(after.status).toBe("blocked");
    expect(after.forkStatus).toBe("running");
  });

  it("#1003: does not reopen a fork child already joined/closed when its own session exits afterward", async () => {
    // Simulate the state immediately AFTER a successful join: the child's own
    // CLI process is still shutting down (its session row is still "running"),
    // but the join already flipped it to forkStatus="joined"/status="closed".
    const { childId, joinNodeId } = await seedForkChildAlreadyOnJoinNode(db);
    const closedAt = "2026-07-04T20:58:13.640Z";
    await db.update(workspaces)
      .set({ forkStatus: "joined", status: "closed", closedAt })
      .where(eq(workspaces.id, childId));

    const sessionManager = makeSessionManager();
    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    const [{ id: sessionId }] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, childId));
    // A plain, non-rate-limited exit — the exact case that previously slipped past
    // the "closed && mergedAt" guard because a fork child is closed without ever
    // being merged.
    await db.update(sessions).set({ stats: null }).where(eq(sessions.id, sessionId));
    await runWorkflowOnExit(childId, sessionId, 0);

    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, childId));
    expect(after.status).toBe("closed");
    expect(after.closedAt).toBe(closedAt);
    expect(after.forkStatus).toBe("joined");
    expect(after.currentNodeId).toBe(joinNodeId);
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });
});
