/**
 * Regression test for issue #966:
 * `runWorkflowOnExit` used to write `idle` unconditionally at session exit; the only
 * terminal check ran on a workspace SNAPSHOT read ~60 lines earlier. A merge landing
 * between that snapshot and the idle write got its terminal state (closed+mergedAt)
 * clobbered back to idle — the recurring race class behind #529/#764/#820/#924/#950.
 *
 * The fix enforces the terminal invariant AT WRITE TIME: `setWorkspaceStatus` bakes
 * `NOT (status = 'closed' AND mergedAt IS NOT NULL)` into the UPDATE's WHERE clause,
 * and the exit workflow stops when the write reports it was blocked.
 */

// Mock modules that exit-workflow.ts loads at import time
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
  applyWorkspaceProfileToPrefs: vi.fn((prefs: Map<string, string>) => prefs),
  buildReviewArgs: vi.fn(() => undefined),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
  getEffectiveProfile: vi.fn(() => undefined),
  parseProviderPref: vi.fn(() => "claude"),
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
}));
// hasCommittedChanges spawns git — make it report "no diff" (exit 0)
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null),
    ),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}

function makeSessionManager() {
  return { startSession: vi.fn(async () => randomUUID()) };
}

async function seedActiveWorkspace(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  const doneId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
    { id: inReviewId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now },
    { id: doneId, projectId, name: "Done", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 966, title: "Terminal-state race",
    priority: "high", sortOrder: 0,
    statusId: inProgressId,
    projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-966-test",
    workingDir: "/repo/.worktrees/ak-966-test",
    baseBranch: "master",
    isDirect: false,
    status: "active",
    readyForMerge: false,
    provider: "claude",
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId,
    status: "running",
    createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId, sessionId };
}

/**
 * Wraps a drizzle db so that the FIRST select whose projection matches `matches`
 * runs `before()` just prior to resolving — the injection point that lets a
 * "concurrent" merge land between exit-workflow's workspace snapshot and its
 * idle write (the select on sessions.stats/triggerType sits exactly in between).
 */
function hookSelect(
  db: TestDb,
  matches: (fields?: Record<string, unknown>) => boolean,
  before: () => Promise<void>,
): TestDb {
  const wrapThen = (builder: unknown): unknown =>
    new Proxy(builder as object, {
      get(t, p) {
        if (p === "then") {
          const origThen = (t as { then: (...a: unknown[]) => unknown }).then.bind(t);
          return (onFulfilled?: unknown, onRejected?: unknown) =>
            before().then(() => origThen(onFulfilled, onRejected), onRejected as (r: unknown) => unknown);
        }
        const v = Reflect.get(t, p);
        return typeof v === "function"
          ? (...args: unknown[]) => wrapThen((v as (...a: unknown[]) => unknown).apply(t, args))
          : v;
      },
    });
  return new Proxy(db as unknown as object, {
    get(target, prop) {
      const orig = Reflect.get(target, prop);
      if (prop === "select") {
        return (fields?: Record<string, unknown>) => {
          const builder = (target as unknown as TestDb).select(fields as never);
          return matches(fields) ? wrapThen(builder) : builder;
        };
      }
      return typeof orig === "function" ? (orig as (...a: unknown[]) => unknown).bind(target) : orig;
    },
  }) as unknown as TestDb;
}

describe("exit-workflow: concurrent merge vs idle write (issue #966)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("does NOT flap a workspace merged after the snapshot back to idle", async () => {
    const { workspaceId, sessionId } = await seedActiveWorkspace(db);
    const mergedAt = new Date().toISOString();

    // Land the merge while runWorkflowOnExit is in flight: after its workspace
    // snapshot (it read status="active"), but before the idle write. The hook fires
    // on the sessions stats/triggerType select, which sits exactly in that window.
    const racingDb = hookSelect(
      db,
      (fields) => !!fields && "stats" in fields && "triggerType" in fields,
      async () => {
        await db.update(workspaces)
          .set({ status: "closed", mergedAt, workingDir: null, readyForMerge: false })
          .where(eq(workspaces.id, workspaceId));
      },
    );

    const boardEvents = makeBoardEvents();
    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: racingDb as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    // Terminal state must win the race — no flap back to idle.
    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBe(mergedAt);

    // And the exit workflow must not have announced an idle workspace.
    const broadcastEvents = boardEvents.broadcast.mock.calls.map((c) => c[1]);
    expect(broadcastEvents).not.toContain("workspace_idle");
    expect(broadcastEvents).toContain("session_completed");
  });

  it("control: without a concurrent merge the exit still goes idle normally", async () => {
    const { workspaceId, sessionId } = await seedActiveWorkspace(db);

    const boardEvents = makeBoardEvents();
    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    const [ws] = await db.select({ status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
    const broadcastEvents = boardEvents.broadcast.mock.calls.map((c) => c[1]);
    expect(broadcastEvents).toContain("workspace_idle");
  });
});

describe("setWorkspaceStatus: terminal invariant enforced at WRITE time (issue #966)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("blocks the write even when the pre-read saw a stale non-terminal snapshot", async () => {
    const { workspaceId } = await seedActiveWorkspace(db);
    const mergedAt = new Date().toISOString();
    await db.update(workspaces)
      .set({ status: "closed", mergedAt })
      .where(eq(workspaces.id, workspaceId));

    // Feed setWorkspaceStatus a db whose SELECTs return a stale "active" snapshot,
    // simulating the merge landing between its pre-read and its UPDATE. Only the
    // atomic WHERE-clause guard can stop the revive here.
    const staleDb = new Proxy(db as unknown as object, {
      get(target, prop) {
        const orig = Reflect.get(target, prop);
        if (prop === "select") {
          const staleBuilder = {
            from() { return this; },
            where() { return this; },
            limit: async () => [{ status: "active", mergedAt: null }],
          };
          return () => staleBuilder;
        }
        return typeof orig === "function" ? (orig as (...a: unknown[]) => unknown).bind(target) : orig;
      },
    }) as unknown as TestDb;

    const ok = await setWorkspaceStatus(staleDb as never, workspaceId, "idle");
    expect(ok).toBe(false);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBe(mergedAt);
  });

  it("returns false for a missing workspace row (write matched nothing)", async () => {
    const ok = await setWorkspaceStatus(db as never, randomUUID(), "idle");
    expect(ok).toBe(false);
  });
});
