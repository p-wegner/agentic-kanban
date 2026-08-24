// @covers container-mcp.reattach.refresh [state-transition,regression]
//
// #156: a containerized builder's MCP HTTP bridge (mcp-http-bridge.service.ts) is
// per-boot and torn down on EVERY server shutdown, including SIGTERM/hot-reload
// (process-handlers.ts), while the containerized agent process itself is detached
// and survives. Reattaching that survivor without rewriting its mounted MCP config
// leaves it dialing a dead port with a dead token for the rest of its run.
//
// This drives the REAL boot routine `cleanupStaleSessions` (startup-tasks.ts) with a
// containerized "running" session (containerId set) and verifies:
//  - the container's MCP config is rewritten via refreshContainerMcpConfig
//  - a workspace comment is recorded noting the refresh
//  - a NON-containerized survivor (no containerId) never triggers either.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// --- Route the boot routine's module-level db at a REAL in-memory test DB ---------------------
const h = vi.hoisted(() => ({ db: undefined as unknown as import("./helpers/test-db.js").TestDb }));
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const { db } = createTestDb();
  h.db = db;
  return {
    db,
    writeDb: db,
    rawClient: {},
    rawWriteClient: {},
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) => database.transaction(fn),
  };
});
// Keep startup-tasks' heavy import graph inert at load (mirrors startup-tasks.test.ts).
vi.mock("../services/git.service.js", () => ({
  isMergeInProgress: vi.fn(async () => false),
  abortMerge: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
}));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));

const refreshContainerMcpConfig = vi.fn<(workspaceId: string, hostTmp?: string) => Promise<string | undefined>>();
vi.mock("../services/devcontainer-workspace.service.js", () => ({
  refreshContainerMcpConfig: (...args: [string, string?]) => refreshContainerMcpConfig(...args),
}));

const insertIssueComment = vi.fn(async (_input: AddIssueCommentInput) => ({}));
vi.mock("../repositories/issue-comments.repository.js", () => ({
  insertIssueComment: (...args: Parameters<typeof insertIssueComment>) => insertIssueComment(...args),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// Import real units AFTER the mocks are registered.
const { cleanupStaleSessions } = await import("../startup/startup-tasks.js");
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import type { SessionManager } from "../services/session.manager.js";
import type { AddIssueCommentInput } from "../repositories/issue-comments.repository.js";
import type * as agentServiceType from "../services/agent.service.js";
import type { TestDb } from "./helpers/test-db.js";

interface Seeded { projectId: string; issueId: string; workspaceId: string; }

async function seedWorkspace(db: TestDb, issueNumber: number): Promise<Seeded> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: `feature/ak-${issueNumber}`,
    workingDir: `/tmp/repo/.worktrees/ak-${issueNumber}`,
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId };
}

async function insertRunningSession(
  db: TestDb,
  workspaceId: string,
  opts: { pid: number | null; containerId?: string | null },
): Promise<string> {
  const sessionId = randomUUID();
  const oldStartedAt = new Date(Date.now() - 60_000).toISOString();
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "running",
    startedAt: oldStartedAt, pid: opts.pid, containerId: opts.containerId ?? null,
  });
  return sessionId;
}

function fakeSessionManager(): SessionManager {
  return {
    reattachSession: vi.fn(),
    handleOutput: vi.fn(),
    notifyExternalExit: vi.fn(async () => {}),
  } as unknown as SessionManager;
}

function fakeAgentServiceModule(): typeof agentServiceType {
  return { reattachSession: vi.fn() } as unknown as typeof agentServiceType;
}

describe("container-mcp.reattach.refresh — cleanupStaleSessions refreshes containerized MCP config", () => {
  beforeEach(() => {
    refreshContainerMcpConfig.mockReset();
    insertIssueComment.mockClear();
  });

  // Sessions the routine reattaches stay "running" in the DB (that IS the surviving
  // state) — without this, a prior test's row would still be picked up by the next
  // test's cleanupStaleSessions() call and pollute its call-count assertions.
  afterEach(async () => {
    await h.db.update(sessions).set({ status: "stopped", endedAt: new Date().toISOString() });
  });

  it("rewrites the MCP config and records a comment for a reattached containerized survivor", async () => {
    const seeded = await seedWorkspace(h.db, 1);
    const sessionId = await insertRunningSession(h.db, seeded.workspaceId, {
      pid: process.pid,
      containerId: "container-abc123",
    });

    refreshContainerMcpConfig.mockResolvedValueOnce("/tmp/agentic-kanban-mcp-config.container.ws1.json");

    await cleanupStaleSessions(fakeSessionManager(), fakeAgentServiceModule());

    expect(refreshContainerMcpConfig).toHaveBeenCalledTimes(1);
    expect(refreshContainerMcpConfig).toHaveBeenCalledWith(seeded.workspaceId);

    expect(insertIssueComment).toHaveBeenCalledTimes(1);
    const [commentArg] = insertIssueComment.mock.calls[0];
    expect(commentArg).toMatchObject({
      issueId: seeded.issueId,
      workspaceId: seeded.workspaceId,
      kind: "note",
      author: "system",
    });
    expect(String(commentArg.body)).toMatch(/refreshed/i);

    void sessionId;
  });

  it("does not touch the MCP config or post a comment for a non-containerized survivor", async () => {
    const seeded = await seedWorkspace(h.db, 2);
    await insertRunningSession(h.db, seeded.workspaceId, { pid: process.pid, containerId: null });

    await cleanupStaleSessions(fakeSessionManager(), fakeAgentServiceModule());

    expect(refreshContainerMcpConfig).not.toHaveBeenCalled();
    expect(insertIssueComment).not.toHaveBeenCalled();
  });

  it("warns but does not throw when the bridge cannot restart (best-effort)", async () => {
    const seeded = await seedWorkspace(h.db, 3);
    await insertRunningSession(h.db, seeded.workspaceId, {
      pid: process.pid,
      containerId: "container-def456",
    });

    refreshContainerMcpConfig.mockResolvedValueOnce(undefined);

    await expect(cleanupStaleSessions(fakeSessionManager(), fakeAgentServiceModule())).resolves.not.toThrow();
    expect(insertIssueComment).not.toHaveBeenCalled();
  });
});
