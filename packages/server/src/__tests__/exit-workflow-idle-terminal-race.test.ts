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
  // #377: runPreMergeGate reads the diff to decide docs-only/package-scoped skips.
  getChangedFileNames: vi.fn(async () => [] as string[]),
}));
vi.mock("../services/agent-settings.service.js", () => ({
  // #541: exit-workflow / merge-workflow now resolve their launch settings here instead
  // of hand-rolling the ladder, so these two must exist on the mock.
  applyWorkspaceProfileToPrefs: vi.fn((m: Map<string, string>) => m),
  resolveWorkspaceLaunchSettings: vi.fn(() => ({
    agentCommand: undefined, agentArgs: undefined, profile: undefined,
    provider: "claude", resumeWithNewModel: false, permissionPromptTool: undefined,
  })),
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));
// #557: the `startup/review-helpers.js` shim is gone — the engine calls the service helper
// with its own db. Partial mock so the rest of review.service stays real.
vi.mock("../services/review.service.js", async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  buildReviewPrompt: vi.fn(async () => ({ prompt: "review", model: undefined })),
}));
vi.mock("../startup/merge-strategy.js", () => ({
  isAutomaticMergeEnabled: vi.fn(() => false),
}));
// hasCommittedChanges() counts commits with `git rev-list --count <base>..HEAD` (#365 — it
// used to ask `git diff --quiet <base>`). Report ZERO commits ahead: no committed changes.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
        args[0] === "rev-list" ? cb(null, "0\n", "") : cb(null, "", ""),
    ),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";

/**
 * #539: `getCommitCountAhead` guards on `existsSync(<dir>/.git)` before spawning, so a
 * made-up path short-circuits to "unknown" — which the exit workflow reads as "assume
 * commits" — no matter what the execFile mock below returns. Production behaviour is
 * unchanged (a real missing worktree makes the spawn fail and yields the same "unknown"),
 * but a fixture that only mocks execFile can no longer stand in for a worktree. So make one.
 * Same fix as `zero-diff-inreview-exit.test.ts`, which shares this fixture shape.
 */
function fakeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-966-ws-"));
  writeFileSync(join(dir, ".git"), "gitdir: /nowhere");
  return dir;
}

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
    workingDir: fakeWorktree(),
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
    startedAt: now,
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

  // #74: a sibling-only ticket's auto-merge cleans its branch, so a later exit pass sees
  // no committed changes while the issue is In Review — the "close as Done" path. That path
  // used setWorkspaceStatus (no mergedAt), leaving a genuinely-merged workspace with
  // mergedAt=null. It must stamp mergedAt (the work already landed to reach In Review).
  it("stamps mergedAt when closing an already-landed workspace (In Review, no committed changes) — #74", async () => {
    const { projectId, issueId, workspaceId, sessionId } = await seedActiveWorkspace(db);
    const [inReview] = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "In Review")));
    await db.update(issues).set({ statusId: inReview.id }).where(eq(issues.id, issueId));

    const boardEvents = makeBoardEvents();
    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).not.toBeNull(); // was null before the #74 fix
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
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

/**
 * #764 — the SAME race one variant deeper, and the reason this file needed a second
 * describe block rather than a second assertion.
 *
 * #966 (above) made the terminal invariant atomic, but it lives in `setWorkspaceStatus`'s
 * UPDATE ... WHERE as `NOT (status='closed' AND mergedAt IS NOT NULL)` — it has no
 * knowledge of `forkStatus`. #1003 later found that a fork child is closed by its JOIN with
 * `forkStatus="joined"` and `mergedAt` left NULL, and fixed only the SNAPSHOT guard at the
 * top of `runWorkflowOnExit`.
 *
 * The two fixes never met. A child joined AFTER the snapshot read but BEFORE the idle write
 * passes the snapshot guard (not closed yet) and then passes #966's atomic guard (mergedAt
 * is null) — so it is flapped to `status="idle"` with `closedAt` still stamped from the
 * join, which is exactly the symptom #1003 reports. `terminalGuardCasStatus` closes it by
 * CAS-ing the idle write on the observed status for fork children.
 *
 * PROOF THIS TEST IS NOT VACUOUS: with `onlyIfCurrentStatus` removed from the idle write in
 * exit-workflow.ts, the first case below fails with `status="idle"` (expected "closed") —
 * i.e. it reproduces #1003 in its concurrent form. Verified by hand-editing that argument
 * out and re-running.
 */
describe("exit-workflow: concurrent fork JOIN vs idle write (issue #764, #1003 concurrent form)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  /** Turn the seeded workspace into a live fork child of `parentId`. */
  async function makeForkChild(workspaceId: string) {
    const parentId = randomUUID();
    await db.update(workspaces)
      .set({ parentWorkspaceId: parentId, forkStatus: "running" })
      .where(eq(workspaces.id, workspaceId));
    return parentId;
  }

  it("does NOT reopen a fork child whose JOIN closed it after the snapshot", async () => {
    const { workspaceId, sessionId } = await seedActiveWorkspace(db);
    await makeForkChild(workspaceId);
    const closedAt = new Date().toISOString();

    // The join lands in the same window #966's test uses: after the workspace snapshot,
    // before the idle write. Note mergedAt stays NULL — a fork child is never individually
    // merged, which is precisely why #966's atomic guard cannot see this transition.
    const racingDb = hookSelect(
      db,
      (fields) => !!fields && "stats" in fields && "triggerType" in fields,
      async () => {
        await db.update(workspaces)
          .set({ status: "closed", forkStatus: "joined", closedAt })
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

    const [ws] = await db.select({
      status: workspaces.status, forkStatus: workspaces.forkStatus,
      mergedAt: workspaces.mergedAt, closedAt: workspaces.closedAt,
    }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.forkStatus).toBe("joined");
    expect(ws.closedAt).toBe(closedAt);
    // The #1003 symptom was status="idle" WITH closedAt stamped — a functionally-done
    // workspace stuck showing idle/active. Assert the incoherent pair cannot occur.
    expect(ws.mergedAt).toBeNull();

    const broadcastEvents = boardEvents.broadcast.mock.calls.map((c) => c[1]);
    expect(broadcastEvents).not.toContain("workspace_idle");
    expect(broadcastEvents).toContain("session_completed");
  });

  it("still skips on the SNAPSHOT path when the join already landed (#1003, unchanged)", async () => {
    const { workspaceId, sessionId } = await seedActiveWorkspace(db);
    await makeForkChild(workspaceId);
    const closedAt = new Date().toISOString();
    await db.update(workspaces)
      .set({ status: "closed", forkStatus: "cancelled", closedAt })
      .where(eq(workspaces.id, workspaceId));

    const boardEvents = makeBoardEvents();
    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    const [ws] = await db.select({ status: workspaces.status, forkStatus: workspaces.forkStatus })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.forkStatus).toBe("cancelled");
  });

  it("control: a fork child with NO concurrent join still goes idle normally", async () => {
    const { workspaceId, sessionId } = await seedActiveWorkspace(db);
    await makeForkChild(workspaceId);

    const boardEvents = makeBoardEvents();
    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: makeSessionManager() as never,
      boardEvents: boardEvents as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 0);

    // The CAS is on the OBSERVED status, so an undisturbed fork child must still go idle —
    // otherwise the guard would strand every fork child's exit workflow.
    const [ws] = await db.select({ status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
    const broadcastEvents = boardEvents.broadcast.mock.calls.map((c) => c[1]);
    expect(broadcastEvents).toContain("workspace_idle");
  });

  it("a NON-fork workspace keeps its unconditional idle write (no new CAS)", async () => {
    const { workspaceId, sessionId } = await seedActiveWorkspace(db);
    // No parentWorkspaceId: terminalGuardCasStatus returns undefined, so behaviour is
    // byte-for-byte the pre-#764 path. Guards against the CAS being widened to every
    // workspace, which would turn any benign concurrent status write into a skipped exit.
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
  });
});
