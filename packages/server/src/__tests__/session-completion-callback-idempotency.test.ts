vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error("branch has committed changes"));
      },
    ),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  issues,
  preferences,
  projects,
  projectStatuses,
  sessions,
  workspaces,
} from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockProc } from "./helpers/mocks.js";
import { createSessionLifecycle, type AgentService } from "../services/session-manager/session-lifecycle.js";
import { createSessionState } from "../services/session-manager/types.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import type { AgentOutputCallback } from "../services/agent.service.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";

function createFakeAgentService(): { service: AgentService; getOnOutput: () => AgentOutputCallback | undefined } {
  let captured: AgentOutputCallback | undefined;
  const service = {
    launch: vi.fn((_dir, _sid, _prompt, _args, onOutput: AgentOutputCallback) => {
      captured = onOutput;
      return createMockProc();
    }),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput: vi.fn(() => true),
    isPidAlive: vi.fn(() => true),
  } as unknown as AgentService;
  return { service, getOnOutput: () => captured };
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}

async function flush(predicate?: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    if (!predicate || predicate()) return;
  }
}

async function seedActiveWorkspace(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "P",
    repoPath: "/tmp/repo",
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inReviewId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 682,
    title: "Repeated completion callback",
    priority: "medium",
    sortOrder: 0,
    statusId: inProgressId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-682-test",
    workingDir: "/tmp/repo/.worktrees/ak-682-test",
    baseBranch: "main",
    isDirect: false,
    status: "active",
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(preferences).values({ key: "auto_review", value: "false", updatedAt: now });

  return { projectId, issueId, workspaceId };
}

async function getIssueStatusName(db: TestDb, issueId: string): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

describe("session completion callback idempotency", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("runs the workspace completion workflow once when a completion callback is repeated", async () => {
    const { projectId, issueId, workspaceId } = await seedActiveWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const state = createSessionState();
    const boardEvents = makeBoardEvents();
    const workflowPromises: Promise<void>[] = [];

    const engine = createWorkflowEngine({
      sessionManager: { startSession: vi.fn(async () => randomUUID()) } as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });
    const onSessionExit = vi.fn((wsId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) => {
      workflowPromises.push(engine.runWorkflowOnExit(wsId, sessionId, exitCode, wasPlanMode));
    });

    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      vi.fn(),
      { db, agentService, preflight: okPreflight() },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    state.sessionSubstantiveOutput.add(sessionId);

    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({ type: "exit", exitCode: 0 } as never);
    onOutput!({ type: "exit", exitCode: 0 } as never);

    await flush(() => workflowPromises.length === 1);
    await Promise.all(workflowPromises);

    onOutput!({ type: "exit", exitCode: 0 } as never);
    await flush();

    expect(onSessionExit).toHaveBeenCalledTimes(1);

    const [session] = await db.select({ status: sessions.status, exitCode: sessions.exitCode })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session).toMatchObject({ status: "completed", exitCode: "0" });

    const [workspace] = await db.select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(workspace.status).toBe("idle");
    expect(await getIssueStatusName(db, issueId)).toBe("In Review");
    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "workspace_idle");
    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "issue_updated");
  });
});
