/**
 * The implement-exit check at the builder -> review transition, through the real exit workflow
 * (`runWorkflowOnExit`) with the check itself stubbed:
 *   - red: no review is launched, the issue stays In Progress, the builder gets ONE feedback turn;
 *   - green: the issue moves to In Review and review launches as before;
 *   - a ticket group (#661) is checked once per builder exit, never per member;
 *   - red past the feedback cap: the workspace is marked for attention (blocked + comment).
 * Harness shape follows `active-stopped-workspace-enters-review.test.ts`.
 */
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "master", conflictingFiles: [], uncommittedChanges: [] })),
  getChangedFileNames: vi.fn(async () => [] as string[]),
}));
vi.mock("../services/agent-settings.service.js", () => ({
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
  resolveWorkspaceLaunchSettings: vi.fn(() => ({
    agentCommand: undefined, agentArgs: undefined, profile: undefined,
    provider: "claude", resumeWithNewModel: false, permissionPromptTool: undefined,
  })),
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));
vi.mock("../services/review.service.js", async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
}));
vi.mock("../startup/merge-strategy.js", () => ({ isAutomaticMergeEnabled: vi.fn(() => false) }));
// hasCommittedChanges() counts commits ahead: report one, every other git call fails as in the
// harness this file copies.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
        args[0] === "rev-list" ? cb(null, "1\n", "") : cb(new Error("git: mocked failure"), "", ""),
    ),
  };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issueComments, issues, projectStatuses, projects, sessions, workspaceIssueMembers, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import type { ImplementExitCheckResult, RunImplementExitCheckArgs } from "../services/implement-exit-check.service.js";
import { getImplementExitAttention, resetAllImplementExitCheckStateForTests } from "../services/implement-exit-check-state.js";

type Db = ReturnType<typeof createTestDb>["db"];

const RED: ImplementExitCheckResult = {
  level: "impact", ran: true, passed: false, held: false,
  message: "implement-exit check FAILED (impact selection of 4 test file(s), 1 failing suite(s))",
  failureDetail: "Failing suites:\n- packages/server/src/__tests__/broken.test.ts",
  selectionSize: 4, durationMs: 1200,
};
const GREEN: ImplementExitCheckResult = { ...RED, passed: true, message: "implement-exit check passed", failureDetail: null };

async function seed(db: Db, opts: { groupMembers?: number } = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID();
  const inProgress = randomUUID(), inReview = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values([
    { id: inProgress, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inReview, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
    { id: randomUUID(), projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "lead", priority: "medium", sortOrder: 0, statusId: inProgress, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/repo/.worktrees/ak-1", baseBranch: "master",
    isDirect: false, status: "active", readyForMerge: false, provider: "claude", createdAt: now, updatedAt: now,
  });
  for (let i = 0; i < (opts.groupMembers ?? 0); i++) {
    const memberId = randomUUID();
    await db.insert(issues).values({ id: memberId, issueNumber: 10 + i, title: `member ${i}`, priority: "medium", sortOrder: 0, statusId: inProgress, projectId, createdAt: now, updatedAt: now });
    await db.insert(workspaceIssueMembers).values({ workspaceId, issueId: memberId, createdAt: now });
  }
  await db.insert(sessions).values({ id: sessionId, workspaceId, status: "completed", startedAt: now });
  return { issueId, workspaceId, sessionId };
}

async function statusName(db: Db, issueId: string): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

function engine(db: Db, verdicts: ImplementExitCheckResult[]) {
  const sessionManager = { startSession: vi.fn(async () => randomUUID()) };
  const runCheck = vi.fn(async (_args: RunImplementExitCheckArgs) => verdicts.shift() ?? GREEN);
  const sendBuilderTurn = vi.fn(async (_workspaceId: string, _content: string) => ({ type: "resumed" }));
  const boardEvents = { broadcast: vi.fn(), broadcastActivity: vi.fn() };
  const { runWorkflowOnExit } = createWorkflowEngine({
    sessionManager: sessionManager as never,
    boardEvents: boardEvents as never,
    autoMerge: vi.fn(async () => {}),
    database: db as never,
    implementExit: { runCheck, sendBuilderTurn },
  });
  return { runWorkflowOnExit, sessionManager, runCheck, sendBuilderTurn, boardEvents };
}

describe("implement-exit check at the builder -> review transition", () => {
  let db: Db;
  beforeEach(() => {
    ({ db } = createTestDb());
    resetAllImplementExitCheckStateForTests();
  });

  it("red: no review launched, the issue stays In Progress, one feedback turn names the failures", async () => {
    const { issueId, workspaceId, sessionId } = await seed(db);
    const e = engine(db, [RED]);

    await e.runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(e.runCheck).toHaveBeenCalledTimes(1);
    expect(e.runCheck.mock.calls[0][0].level).toBe("impact"); // standard posture -> impact
    expect(e.sessionManager.startSession).not.toHaveBeenCalled();
    expect(await statusName(db, issueId)).toBe("In Progress");
    expect(e.sendBuilderTurn).toHaveBeenCalledTimes(1);
    expect(e.sendBuilderTurn.mock.calls[0][0]).toBe(workspaceId);
    expect(e.sendBuilderTurn.mock.calls[0][1]).toContain("packages/server/src/__tests__/broken.test.ts");
  });

  it("green: moves to In Review and launches review as before", async () => {
    const { issueId, workspaceId, sessionId } = await seed(db);
    const e = engine(db, [GREEN]);

    await e.runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(e.runCheck).toHaveBeenCalledTimes(1);
    expect(await statusName(db, issueId)).toBe("In Review");
    expect(e.sessionManager.startSession).toHaveBeenCalledTimes(1);
    expect(e.sendBuilderTurn).not.toHaveBeenCalled();
  });

  it("red then green: the feedback session's exit re-runs the check, and green launches review", async () => {
    const { issueId, workspaceId, sessionId } = await seed(db);
    const e = engine(db, [RED, GREEN]);

    await e.runWorkflowOnExit(workspaceId, sessionId, 0);
    await e.runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(e.runCheck).toHaveBeenCalledTimes(2);
    expect(e.sendBuilderTurn).toHaveBeenCalledTimes(1);
    expect(await statusName(db, issueId)).toBe("In Review");
    expect(e.sessionManager.startSession).toHaveBeenCalledTimes(1);
  });

  it("a ticket group is checked once per builder exit, after the last member, not per member", async () => {
    const { issueId, workspaceId, sessionId } = await seed(db, { groupMembers: 2 });
    const e = engine(db, [GREEN]);
    const log = vi.spyOn(console, "log");

    await e.runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(e.runCheck).toHaveBeenCalledTimes(1);
    expect(e.runCheck.mock.calls[0][0].workspace.id).toBe(workspaceId);
    expect(log.mock.calls.some(([line]) => String(line).includes("ticket group of 3") && String(line).includes("verdict green"))).toBe(true);
    expect(await statusName(db, issueId)).toBe("In Review");
    log.mockRestore();
  });

  it("red past the cap: the workspace is marked for attention, visibly, and review is not launched", async () => {
    const { issueId, workspaceId, sessionId } = await seed(db);
    const e = engine(db, [RED, RED, RED]);

    await e.runWorkflowOnExit(workspaceId, sessionId, 0);
    await e.runWorkflowOnExit(workspaceId, sessionId, 0);
    await e.runWorkflowOnExit(workspaceId, sessionId, 0);

    expect(e.runCheck).toHaveBeenCalledTimes(3);
    expect(e.sendBuilderTurn).toHaveBeenCalledTimes(2);
    expect(e.sessionManager.startSession).not.toHaveBeenCalled();
    expect(await statusName(db, issueId)).toBe("In Progress");
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("blocked");
    expect(getImplementExitAttention(workspaceId)?.reason).toContain("broken.test.ts");
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((c) => c.body.startsWith("Needs attention: the implement-exit check is still red after 2 feedback turn(s)"))).toBe(true);
    expect(e.boardEvents.broadcast).toHaveBeenCalledWith(expect.any(String), "workflow_error");
  });

  it("no implementExit wiring: no check runs (the engine's other tests stay spawn-free)", async () => {
    const { issueId, workspaceId, sessionId } = await seed(db);
    const sessionManager = { startSession: vi.fn(async () => randomUUID()) };
    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: { broadcast: vi.fn(), broadcastActivity: vi.fn() } as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });
    await runWorkflowOnExit(workspaceId, sessionId, 0);
    expect(await statusName(db, issueId)).toBe("In Review");
  });
});
