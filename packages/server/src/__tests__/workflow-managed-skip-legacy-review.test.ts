/**
 * Regression test for issue #997:
 * A workspace parked on a non-terminal workflow-template node (workspaces.currentNodeId
 * set, node type != "end") is owned by the GRAPH — its own node-driven stages decide
 * review/fix. The legacy auto-review pipeline (triggerType "review") must NOT launch for
 * it, and readyForMerge must never arm from that legacy path. Observed live on #996: a
 * Prepare-stage builder exit with a planning-docs-only commit launched legacy auto-review,
 * which would have set readyForMerge=true on a branch never intended to merge yet.
 */

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
}));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("../services/agent-settings.service.js", () => ({
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));
vi.mock("../startup/review-helpers.js", () => ({
  buildReviewArgs: vi.fn(() => undefined),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
  getEffectiveProfile: vi.fn(() => undefined),
  parseProviderPref: vi.fn(() => "claude"),
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
}));
// hasCommittedChanges uses execFile — return exit code 1 with stdout (has a diff = committed changes).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: (Error & { code?: number }) | null, stdout?: string) => void) =>
        cb(Object.assign(new Error("git diff --quiet exited 1"), { code: 1 }), "M PLANNING-CONTEXT.md\n"),
    ),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import { reconcileStrandedReviews } from "../startup/stranded-review-reconciler.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}

function makeSessionManager() {
  return { startSession: vi.fn(async () => randomUUID()) };
}

async function seedWorkflowManagedBuilderExit(db: ReturnType<typeof createTestDb>["db"], nodeType: "normal" | "end") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const builderSessionId = randomUUID();
  const templateId = randomUUID();
  const nodeId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inReviewId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(workflowTemplates).values({
    id: templateId, projectId, name: "Multi-harness plan review",
    ticketType: null, isDefault: false, isBuiltin: false, createdAt: now, updatedAt: now,
  });
  await db.insert(workflowNodes).values({
    id: nodeId, templateId, name: "Prepare", nodeType, statusName: null, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 996, title: "Multi-harness plan review",
    priority: "medium", sortOrder: 0,
    statusId: inProgressId,
    projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-996-test",
    workingDir: "/repo/.worktrees/ak-996-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: false,
    requiresReview: true,
    provider: "claude",
    currentNodeId: nodeId,
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: builderSessionId, workspaceId,
    status: "running",
    triggerType: "builder",
    createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId, builderSessionId };
}

describe("exit-workflow: workflow-managed workspaces skip legacy auto-review (issue #997)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("does NOT launch a legacy triggerType:review session for a workspace on a non-terminal workflow node", async () => {
    const { workspaceId, builderSessionId } = await seedWorkflowManagedBuilderExit(db, "normal");

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const engine = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await engine.runWorkflowOnExit(workspaceId, builderSessionId, 0);

    expect(sessionManager.startSession).not.toHaveBeenCalled();

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge, status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
    expect(ws.status).toBe("idle");
  });

  it("still launches legacy auto-review for a workspace on a terminal (end) workflow node", async () => {
    const { workspaceId, builderSessionId } = await seedWorkflowManagedBuilderExit(db, "end");

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const engine = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await engine.runWorkflowOnExit(workspaceId, builderSessionId, 0);

    expect(sessionManager.startSession).toHaveBeenCalled();
  });

  it("still launches legacy auto-review for a non-workflow-managed workspace (no currentNodeId)", async () => {
    const { workspaceId, builderSessionId, issueId, projectId } = await (async () => {
      const now = new Date().toISOString();
      const pId = randomUUID();
      const inProgressId = randomUUID();
      const inReviewId = randomUUID();
      const iId = randomUUID();
      const wsId = randomUUID();
      const sessId = randomUUID();

      await db.insert(projects).values({
        id: pId, name: "Test", repoPath: "/repo", repoName: "repo",
        defaultBranch: "master", createdAt: now, updatedAt: now,
      });
      await db.insert(projectStatuses).values([
        { id: inProgressId, projectId: pId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
        { id: inReviewId, projectId: pId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
      ]);
      await db.insert(issues).values({
        id: iId, issueNumber: 998, title: "Legacy ticket",
        priority: "medium", sortOrder: 0,
        statusId: inProgressId,
        projectId: pId, createdAt: now, updatedAt: now,
      });
      await db.insert(workspaces).values({
        id: wsId, issueId: iId,
        branch: "feature/ak-998-test",
        workingDir: "/repo/.worktrees/ak-998-test",
        baseBranch: "master",
        isDirect: false,
        status: "idle",
        readyForMerge: false,
        requiresReview: true,
        provider: "claude",
        currentNodeId: null,
        createdAt: now, updatedAt: now,
      });
      await db.insert(sessions).values({
        id: sessId, workspaceId: wsId,
        status: "running",
        triggerType: "builder",
        createdAt: now, updatedAt: now,
      });
      return { workspaceId: wsId, builderSessionId: sessId, issueId: iId, projectId: pId };
    })();

    const boardEvents = makeBoardEvents();
    const sessionManager = makeSessionManager();

    const engine = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await engine.runWorkflowOnExit(workspaceId, builderSessionId, 0);

    expect(sessionManager.startSession).toHaveBeenCalled();
    void issueId; void projectId;
  });
});

describe("reconcileStrandedReviews: skips workflow-managed non-terminal workspaces (issue #997)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  function makeDeps(overrides: { enabled?: boolean } = {}) {
    const boardEvents = { broadcast: vi.fn() } as unknown as BoardEvents;
    const sessionManager = {} as SessionManager;
    return {
      database: db,
      getSessionManager: () => sessionManager,
      boardEvents,
      reviewSessionIds: new Set<string>(),
      ...overrides,
    };
  }

  it("does not recover (relaunch or ready-for-merge) an idle In-Review workspace parked on a non-terminal workflow node", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const inReviewStatusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const templateId = randomUUID();
    const nodeId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
    ]);
    await db.insert(workflowTemplates).values({
      id: templateId, projectId, name: "Multi-harness plan review",
      ticketType: null, isDefault: false, isBuiltin: false, createdAt: now, updatedAt: now,
    });
    await db.insert(workflowNodes).values({
      id: nodeId, templateId, name: "Prepare", nodeType: "normal", statusName: null, createdAt: now,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 997, title: "Stranded workflow-managed",
      priority: "medium", sortOrder: 0, statusId: inReviewStatusId, projectId,
      createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId,
      branch: "feature/ak-997-test",
      workingDir: "/repo/.worktrees/ak-997-test",
      baseBranch: "master",
      isDirect: false,
      status: "idle",
      readyForMerge: false,
      provider: "claude",
      currentNodeId: nodeId,
      createdAt: now, updatedAt: now,
    });

    const recovered = await reconcileStrandedReviews(makeDeps());

    expect(recovered).toBe(0);
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
  });
});
