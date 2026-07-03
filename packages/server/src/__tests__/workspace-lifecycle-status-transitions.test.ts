/**
 * Unit tests for workspace lifecycle status-transition paths — ticket #707.
 *
 * Covers:
 *   1. idle → active on launchSession
 *   2. active → reviewing on agent exit-0 with committed changes
 *   3. reviewing → Done on merge success
 *   4. reviewing → stays In Review on merge conflict
 *   5. Stranded session recovery: stopWorkspace resets active workspace to idle
 */

// Module mocks for exit-workflow and workspace-session paths.
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
}));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("../services/agent-settings.service.js", () => {
  const stubAgentSettings = () => ({
    agentCommand: undefined,
    agentArgs: undefined,
    claudeProfile: undefined,
    profile: undefined,
    provider: "claude",
    resumeWithNewModel: false,
    permissionPromptTool: undefined,
  });
  return {
    isMockProfile: vi.fn(() => false),
    toExecutorProvider: vi.fn((p: string) => p),
    MOCK_AGENT_COMMAND: "mock",
    loadAgentSettings: vi.fn(async () => stubAgentSettings()),
    resolveAgentSettings: vi.fn(() => stubAgentSettings()),
  };
});
vi.mock("../startup/review-helpers.js", () => ({
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
  buildReviewArgs: vi.fn(() => undefined),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
  getEffectiveProfile: vi.fn(() => undefined),
  parseProviderPref: vi.fn(() => "claude"),
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
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
// hasCommittedChanges() uses execFile("git", ["diff", "--quiet", base]).
// A non-zero exit (Error callback) means the branch HAS committed changes.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("git diff --quiet: differences present")),
    ),
  };
});

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
  workflowEdges,
} from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { activeMerges } from "../services/workspace-internals.js";

// Test isolation: the per-repoPath merge lock (activeMerges) is a module-level Map
// (see workspace-merge-service.test.ts ~line 22). Clearing it before each test
// prevents a lock left by one test's merge from leaking into the next and failing
// with "A merge is already in progress for this repository".
beforeEach(() => {
  activeMerges.clear();
});

// ─── shared helpers ──────────────────────────────────────────────────────────

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

function makeGit(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, ref: string) => {
      if (ref === "feature/ak-707-test") return "feature-sha";
      if (ref === "master") return "master-sha";
      return "merge-commit-sha";
    }),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: (() => {
      let calls = 0;
      return vi.fn(async () => {
        calls++;
        if (calls === 1) return { isAncestor: false as const, branchSha: "feature-sha", baseSha: "master-sha" };
        return { isAncestor: true as const, branchSha: "feature-sha", baseSha: "merge-commit-sha" };
      });
    })(),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

/**
 * Seed a full scenario with project, statuses, workflow template, issue, and workspace.
 * Returns IDs for use in assertions.
 */
async function seedLifecycleScenario(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    workspaceStatus?: string;
    issueStatus?: "in_progress" | "in_review";
    readyForMerge?: boolean;
    sessionStatus?: "stopped" | "completed" | "running";
  } = {},
) {
  const now = new Date(Date.now() - 60_000).toISOString();
  const projectId = randomUUID();
  const inProgressStatusId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
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
    { id: doneStatusId, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await db.insert(workflowTemplates).values({
    id: templateId, projectId, name: "Simple Ticket", isDefault: true, isBuiltin: false,
    createdAt: now, updatedAt: now,
  });
  await db.insert(workflowNodes).values([
    { id: inProgressNodeId, templateId, name: "Implement", nodeType: "normal", statusName: "In Progress", sortOrder: 0, createdAt: now },
    { id: inReviewNodeId, templateId, name: "Review", nodeType: "normal", statusName: "In Review", sortOrder: 1, createdAt: now },
  ]);
  await db.insert(workflowEdges).values({
    id: randomUUID(), templateId, fromNodeId: inProgressNodeId, toNodeId: inReviewNodeId,
    condition: "auto_on_exit_0", sortOrder: 0, createdAt: now,
  });

  const statusId = opts.issueStatus === "in_review" ? inReviewStatusId : inProgressStatusId;
  await db.insert(issues).values({
    id: issueId, issueNumber: 707, title: "Lifecycle test issue",
    priority: "medium", sortOrder: 0,
    statusId,
    workflowTemplateId: templateId,
    currentNodeId: inProgressNodeId,
    projectId, createdAt: now, updatedAt: now,
  });

  const wsStatus = opts.workspaceStatus ?? "idle";
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-707-test",
    workingDir: "/repo/.worktrees/ak-707-test",
    baseBranch: "master",
    isDirect: false,
    status: wsStatus,
    readyForMerge: opts.readyForMerge ?? (wsStatus === "idle" ? true : false),
    currentNodeId: inProgressNodeId,
    provider: "claude",
    createdAt: now, updatedAt: now,
  });

  if (opts.sessionStatus) {
    await db.insert(sessions).values({
      id: sessionId, workspaceId,
      status: opts.sessionStatus,
      startedAt: now,
    });
  }

  return {
    projectId, issueId, workspaceId, sessionId, templateId,
    inProgressNodeId, inReviewNodeId,
    inProgressStatusId, inReviewStatusId, doneStatusId,
  };
}

async function getIssueStatusName(db: ReturnType<typeof createTestDb>["db"], issueId: string) {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

// ─── 1. idle → active: launchSession ─────────────────────────────────────────

describe("lifecycle: idle → active on launchSession", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("sets workspace status to 'active' after launching a session", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, { workspaceStatus: "idle" });
    const sessionManager = makeSessionManager();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    await svc.launchSession(workspaceId);

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("active");
  });

  it("calls sessionManager.startSession once and returns a sessionId", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, { workspaceStatus: "idle" });
    const sessionManager = makeSessionManager();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    const result = await svc.launchSession(workspaceId);

    expect(sessionManager.startSession).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBeTruthy();
  });

  it("throws NOT_FOUND when the workspace does not exist", async () => {
    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => makeSessionManager() as never,
      boardEvents: makeBoardEvents() as never,
    });

    await expect(svc.launchSession(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─── 2. active → reviewing on agent exit-0 with committed changes ─────────────

describe("lifecycle: active → reviewing on agent exit-0 with committed changes", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("moves issue to In Review and sets workspace to 'reviewing' on exit 0", async () => {
    const { issueId, workspaceId, sessionId, inReviewNodeId } = await seedLifecycleScenario(db, {
      workspaceStatus: "active",
      sessionStatus: "stopped",
    });
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(await getIssueStatusName(db, issueId)).toBe("In Review");

    const [ws] = await db.select({ status: workspaces.status, currentNodeId: workspaces.currentNodeId })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("reviewing");
    expect(ws.currentNodeId).toBe(inReviewNodeId);
  });

  it("launches the auto-review session after the builder exits cleanly", async () => {
    const { workspaceId, sessionId } = await seedLifecycleScenario(db, {
      workspaceStatus: "active",
      sessionStatus: "stopped",
    });
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(sessionManager.startSession).toHaveBeenCalledTimes(1);
  });

  it("leaves issue In Progress when agent exits with non-zero code", async () => {
    const { issueId, workspaceId, sessionId } = await seedLifecycleScenario(db, {
      workspaceStatus: "active",
      sessionStatus: "stopped",
    });
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 1);

    // Non-zero exit — workspace goes idle but issue stays In Progress
    expect(await getIssueStatusName(db, issueId)).toBe("In Progress");
    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });
});

// ─── 3. reviewing → Done on merge success ────────────────────────────────────

describe("lifecycle: reviewing → Done on merge success", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("moves issue to Done after a clean merge", async () => {
    const { issueId, workspaceId } = await seedLifecycleScenario(db, {
      workspaceStatus: "idle",
      issueStatus: "in_review",
      readyForMerge: true,
    });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);

    expect(await getIssueStatusName(db, issueId)).toBe("Done");
  });

  it("closes workspace and sets mergedAt on merge success", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, {
      workspaceStatus: "idle",
      issueStatus: "in_review",
      readyForMerge: true,
    });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });

  it("returns merged=true with baseBranch and SHAs", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, {
      workspaceStatus: "idle",
      issueStatus: "in_review",
      readyForMerge: true,
    });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(true);
    expect(result.baseBranch).toBe("master");
  });
});

// ─── 4. reviewing → In Progress on merge conflict ────────────────────────────

describe("lifecycle: reviewing stays In Review on merge conflict", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("throws CONFLICT when merge has conflicting files", async () => {
    const { workspaceId, issueId } = await seedLifecycleScenario(db, {
      workspaceStatus: "idle",
      issueStatus: "in_review",
      readyForMerge: true,
    });
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
      })),
      detectConflicts: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/conflict.ts"] })),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({ code: "CONFLICT" });

    // Issue stays In Review — not moved to Done
    expect(await getIssueStatusName(db, issueId)).toBe("In Review");
  });

  it("workspace is NOT closed on merge conflict", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, {
      workspaceStatus: "idle",
      issueStatus: "in_review",
      readyForMerge: true,
    });
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
      })),
      detectConflicts: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/conflict.ts"] })),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toThrow();

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).not.toBe("closed");
    expect(ws.mergedAt).toBeNull();
  });

  it("throws CONFLICT with mergeReason=not_approved when not ready for merge", async () => {
    const { workspaceId, issueId } = await seedLifecycleScenario(db, {
      workspaceStatus: "idle",
      issueStatus: "in_review",
      readyForMerge: false,
    });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "not_approved" },
    });

    expect(await getIssueStatusName(db, issueId)).toBe("In Review");
  });
});

// ─── 5. Stranded-session recovery: stopWorkspace resets active workspace ──────

describe("lifecycle: stranded-session recovery via stopWorkspace", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("resets active workspace to idle when stopWorkspace is called", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, {
      workspaceStatus: "active",
      sessionStatus: "running",
    });
    const sessionManager = makeSessionManager();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    await svc.stopWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("calls sessionManager.stopSession for any running session", async () => {
    const { workspaceId, sessionId } = await seedLifecycleScenario(db, {
      workspaceStatus: "active",
      sessionStatus: "running",
    });
    const sessionManager = makeSessionManager();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    const result = await svc.stopWorkspace(workspaceId);

    expect(result.stopped).toBe(true);
    expect(sessionManager.stopSession).toHaveBeenCalledWith(sessionId);
  });

  it("resets reviewing workspace to idle (stranded review recovery)", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, {
      workspaceStatus: "reviewing",
      issueStatus: "in_review",
      sessionStatus: "running",
    });
    const sessionManager = makeSessionManager();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    await svc.stopWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("stopWorkspace is safe when there are no running sessions (already stranded idle)", async () => {
    const { workspaceId } = await seedLifecycleScenario(db, {
      workspaceStatus: "active",
      sessionStatus: "stopped",
    });
    const sessionManager = makeSessionManager();

    const svc = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager as never,
      boardEvents: makeBoardEvents() as never,
    });

    // No running session — stopSession must not be called; workspace still resets to idle
    const result = await svc.stopWorkspace(workspaceId);

    expect(sessionManager.stopSession).not.toHaveBeenCalled();
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
    // Returned stopped=false since no session was stopped
    expect(result.stopped).toBe(false);
  });
});
