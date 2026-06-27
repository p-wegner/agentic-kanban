// @covers workspaces.stop.strand-recovery [state-transition]
/**
 * Pins the UNASSERTED side of the stop/strand-recovery transition: the
 * `quarantineWorkspace` sub-behaviour (POST /api/workspaces/:id/quarantine).
 *
 * The existing suite (workspace-lifecycle-status-transitions.test.ts §5) covers
 * the workspace side of stop → idle (active/reviewing → idle, no-op when nothing
 * runs). What is NOT asserted anywhere is the ISSUE-status side of quarantine:
 * quarantine = stopWorkspace + move the issue BACK to In Progress. This file
 * pins that issue-status state-transition.
 *
 * Mutation note: if quarantineWorkspace dropped its moveIssueToInProgress call
 * (or quarantine were aliased to plain stopWorkspace), the issue would stay
 * "In Review" and the `toBe("In Progress")` assertion below would go RED.
 */

// Mock the module graph pulled in by workspace-session.service.ts so the import
// resolves without a real DB / git / agent runtime. Mirrors the neighbouring
// lifecycle test's mock set; only the pieces the session service touches.
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
}));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("../services/agent-settings.service.js", () => ({
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
  loadAgentSettings: vi.fn(async () => ({
    agentCommand: undefined,
    agentArgs: undefined,
    claudeProfile: undefined,
    profile: undefined,
    provider: "claude",
    resumeWithNewModel: false,
    permissionPromptTool: undefined,
  })),
  resolveAgentSettings: vi.fn(() => ({ provider: "claude" })),
}));
vi.mock("../services/phase-artifacts.service.js", () => ({
  buildPhaseArtifactsContext: vi.fn(async () => ""),
  isImplementWorkflowNode: vi.fn(async () => false),
}));
vi.mock("../services/workspace-code-metrics.service.js", () => ({
  computeWorkspaceCodeMetrics: vi.fn(async () => null),
}));
vi.mock("../services/bisect.service.js", () => ({
  stopBisectSession: vi.fn(() => false),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  issues,
  projectStatuses,
  projects,
  sessions,
  workspaces,
  workflowTemplates,
  workflowNodes,
} from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}

function makeSessionManager() {
  return {
    startSession: vi.fn(async () => randomUUID()),
    stopSession: vi.fn(async () => {}),
    sendTurn: vi.fn(() => ({ ok: true })),
  };
}

/**
 * Seed a project with an "In Progress"/"In Review" status pair, an issue
 * currently in In Review, and a workspace mid-review with a running session.
 */
async function seedReviewScenario(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { workspaceStatus?: string; sessionStatus?: "running" | "stopped" } = {},
) {
  const now = new Date(Date.now() - 60_000).toISOString();
  const projectId = randomUUID();
  const inProgressStatusId = randomUUID();
  const inReviewStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const templateId = randomUUID();
  const inProgressNodeId = randomUUID();
  const inReviewNodeId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(workflowTemplates).values({
    id: templateId, projectId, name: "Simple Ticket", isDefault: true, isBuiltin: false,
    createdAt: now, updatedAt: now,
  });
  await db.insert(workflowNodes).values([
    { id: inProgressNodeId, templateId, name: "Implement", nodeType: "normal", statusName: "In Progress", sortOrder: 0, createdAt: now },
    { id: inReviewNodeId, templateId, name: "Review", nodeType: "normal", statusName: "In Review", sortOrder: 1, createdAt: now },
  ]);

  // Issue starts In Review — quarantine must move it BACK to In Progress.
  await db.insert(issues).values({
    id: issueId, issueNumber: 942, title: "Quarantine test issue",
    priority: "medium", sortOrder: 0,
    statusId: inReviewStatusId,
    workflowTemplateId: templateId,
    currentNodeId: inReviewNodeId,
    projectId, createdAt: now, updatedAt: now,
  });

  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-942-test",
    workingDir: "/repo/.worktrees/ak-942-test",
    baseBranch: "master",
    isDirect: false,
    status: opts.workspaceStatus ?? "reviewing",
    readyForMerge: false,
    currentNodeId: inReviewNodeId,
    provider: "claude",
    createdAt: now, updatedAt: now,
  });

  await db.insert(sessions).values({
    id: sessionId, workspaceId,
    status: opts.sessionStatus ?? "running",
    startedAt: now,
  });

  return { projectId, issueId, workspaceId, sessionId, inProgressStatusId, inReviewStatusId };
}

async function getIssueStatusName(db: ReturnType<typeof createTestDb>["db"], issueId: string) {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

describe("strand-recovery state-transition: quarantineWorkspace", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("moves the issue from In Review back to In Progress (the unasserted state-transition)", async () => {
    const { issueId, workspaceId } = await seedReviewScenario(db);

    // Precondition: issue really is In Review before quarantine.
    expect(await getIssueStatusName(db, issueId)).toBe("In Review");

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => makeSessionManager() as never,
      boardEvents: makeBoardEvents() as never,
    });

    await svc.quarantineWorkspace(workspaceId);

    // The mutation under test: quarantine reverts the issue to In Progress.
    expect(await getIssueStatusName(db, issueId)).toBe("In Progress");
  });

  it("resets the workspace to idle and stops the running session on quarantine", async () => {
    const { workspaceId, sessionId } = await seedReviewScenario(db, { workspaceStatus: "reviewing", sessionStatus: "running" });
    const sessionManager = makeSessionManager();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    const result = await svc.quarantineWorkspace(workspaceId);

    expect(result.stopped).toBe(true);
    expect(sessionManager.stopSession).toHaveBeenCalledWith(sessionId);

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("broadcasts a board_changed event so the reverted issue status is reflected", async () => {
    const { projectId, workspaceId } = await seedReviewScenario(db);
    const boardEvents = makeBoardEvents();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => makeSessionManager() as never,
      boardEvents: boardEvents as never,
    });

    await svc.quarantineWorkspace(workspaceId);

    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "board_changed");
  });

  it("throws NOT_FOUND when quarantining a non-existent workspace", async () => {
    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => makeSessionManager() as never,
      boardEvents: makeBoardEvents() as never,
    });

    await expect(svc.quarantineWorkspace(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
