import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, sessionMessages, workspaces, issues, issueComments, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

// #1212 — the reaper now reads the HOST before it reaps: `readTier0Capacity` + 150 ms of
// `readCpuBusyPct`, the same pair #1009/#1173 use, and a live reading on a box running the rest
// of this suite would decide these cases instead of the fixture. Pinned ROOMY by default, the
// way `base-branch-health-recency.test.ts` does it; the saturation case re-pins per test.
const cpuBusyPct = vi.fn(async () => 0);
vi.mock("@agentic-kanban/shared/lib/machine-capacity", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readTier0Capacity: () => ({ tier: "0", hold: false, reason: "test: pinned roomy", freeGb: 32 }),
    readCpuBusyPct: () => cpuBusyPct(),
  };
});
vi.mock("../lib/machine-verify-lock.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, machineVerifyLockEnabled: () => false };
});

const { reconcileCompletionStates } = await import("../startup/completion-state-reconciler.js");

function makeNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function setupScenario(db: ReturnType<typeof createTestDb>["db"], opts: {
  issueStatusName?: string;
  workspaceStatus?: string;
  sessionPid?: number | null;
  sessionStatus?: "running" | "completed" | "stopped";
  workspaceUpdatedAt?: string;
  sessionStartedAt?: string;
  sessionTriggerType?: string;
  /** Newest `session_messages` row — the board's only record of "the agent said something". */
  lastOutputAt?: string;
}) {
  const now = makeNow();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/tmp/test",
    repoName: "test",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: opts.issueStatusName ?? "In Review",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  await db.insert(issues).values({
    id: issueId,
    projectId,
    statusId,
    title: "Test issue",
    issueNumber: 1,
    createdAt: now,
    updatedAt: now,
  });

  const wsUpdatedAt = opts.workspaceUpdatedAt ?? now;
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-1-test",
    status: opts.workspaceStatus ?? "active",
    workingDir: "/tmp/worktree",
    baseBranch: "main",
    isDirect: false,
    createdAt: now,
    updatedAt: wsUpdatedAt,
  });

  await db.insert(sessions).values({
    id: sessionId,
    workspaceId,
    executor: "claude-code",
    status: opts.sessionStatus ?? "running",
    startedAt: opts.sessionStartedAt ?? now,
    triggerType: opts.sessionTriggerType ?? null,
    pid: opts.sessionPid !== undefined ? opts.sessionPid : null,
  });

  if (opts.lastOutputAt) {
    await db.insert(sessionMessages).values({
      sessionId,
      type: "stdout",
      data: "still working",
      createdAt: opts.lastOutputAt,
    });
  }

  return { projectId, statusId, issueId, workspaceId, sessionId };
}

describe("reconcileCompletionStates", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
  });

  it("marks session stopped and workspace idle when PID is null (dead)", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");
    expect(session.endedAt).not.toBeNull();

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("marks session stopped and workspace idle when PID is dead and workspace has committed changes", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 99999,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("does NOT reconcile a dead-PID session when workspace has no committed changes (protects in-flight work)", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "active",
      sessionPid: 99999,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => false,
      checkCommits: async () => false,
    });

    expect(count).toBe(0);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("active");
  });

  it("reconciles hung agent: PID alive, issue in Review, workspace stuck >30min AND the session silent", async () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      workspaceUpdatedAt: staleTime,
      // #1212: silence is now half the rule, so this case has to be silent to stay the case
      // it was written to be. Its last output is as old as the workspace stamp.
      sessionStartedAt: staleTime,
      lastOutputAt: staleTime,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => true,
      checkCommits: async () => true,
      now: new Date().toISOString(),
    });

    expect(count).toBe(1);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("stopped");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("does NOT reconcile a workspace whose PID is alive and issue is still In Progress", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "active",
      sessionPid: 12345,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => true,
      checkCommits: async () => false,
    });

    expect(count).toBe(0);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("active");
  });

  it("does NOT reconcile a workspace where PID is alive and issue is In Review but workspace updated recently", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { sessionId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      workspaceUpdatedAt: recentTime,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: (_pid) => true,
      checkCommits: async () => true,
      now: new Date().toISOString(),
    });

    expect(count).toBe(0);

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");
  });

  it("does not touch already-stopped sessions", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/t", repoName: "t", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now });
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "T", issueNumber: 2, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/t", status: "idle", workingDir: "/t", baseBranch: "main", isDirect: false, createdAt: now, updatedAt: now });
    await db.insert(sessions).values({ id: sessionId, workspaceId, executor: "claude-code", status: "stopped", startedAt: now, pid: null });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(0);
  });

  // ─── blocked workspace auto-recovery (#712) ──────────────────────────────────

  it("auto-recovers blocked workspace to idle when session completed with committed changes", async () => {
    const { workspaceId, sessionId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "blocked",
      sessionStatus: "completed",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");

    // Session status is not changed by blocked recovery — it already completed
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("completed");
  });

  it("auto-recovers blocked workspace to idle when session stopped with committed changes", async () => {
    const { workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "blocked",
      sessionStatus: "stopped",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(1);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("idle");
  });

  it("does NOT auto-recover blocked workspace when session has no committed changes", async () => {
    const { workspaceId } = await setupScenario(db, {
      issueStatusName: "In Progress",
      workspaceStatus: "blocked",
      sessionStatus: "completed",
      sessionPid: null,
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => false,
    });

    expect(count).toBe(0);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("blocked");
  });

  it("does NOT auto-recover blocked workspace when workingDir or baseBranch is missing", async () => {
    const now = makeNow();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "T2", repoPath: "/t2", repoName: "t2", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
    await db.insert(issues).values({ id: issueId, projectId, statusId, title: "T2", issueNumber: 3, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/t2",
      status: "blocked",
      workingDir: null,
      baseBranch: null,
      isDirect: false, createdAt: now, updatedAt: now,
    });
    await db.insert(sessions).values({ id: sessionId, workspaceId, executor: "claude-code", status: "completed", startedAt: now, pid: null });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => false,
      checkCommits: async () => true,
    });

    expect(count).toBe(0);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("blocked");
  });

  // ─── staleness is SILENCE, not wall-clock (#1212) ────────────────────────────

  it("leaves a live session alone at 45 min when it produced output 5 min ago", async () => {
    const { sessionId, workspaceId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      workspaceUpdatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      sessionStartedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      lastOutputAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });

    const count = await reconcileCompletionStates(db, {
      checkPid: () => true,
      checkCommits: async () => true,
      now: new Date().toISOString(),
    });

    expect(count).toBe(0);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(session.status).toBe("running");
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(workspace.status).toBe("active");
  });

  it("stops a live session silent for 35 min, and says 'silent for' rather than 'active for'", async () => {
    const silent = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const { sessionId } = await setupScenario(db, {
        issueStatusName: "In Review",
        workspaceStatus: "active",
        sessionPid: 12345,
        workspaceUpdatedAt: silent,
        sessionStartedAt: silent,
        lastOutputAt: silent,
      });

      const count = await reconcileCompletionStates(db, {
        checkPid: () => true,
        checkCommits: async () => true,
        now: new Date().toISOString(),
      });

      expect(count).toBe(1);
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(session.status).toBe("stopped");
      const detected = logs.find((l) => l.includes("stale session detected"));
      expect(detected).toBeDefined();
      expect(detected).toContain("silent for 35 min");
      expect(detected).not.toContain("active for");
    } finally {
      spy.mockRestore();
    }
  });

  it("doubles both windows on a saturated host, so a 20-min silence at age 45 min is held", async () => {
    const scenario = {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      workspaceUpdatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      sessionStartedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      lastOutputAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    };

    // Roomy host: 20 min of silence clears the 15-min window, 45 min clears the 30-min backstop.
    cpuBusyPct.mockResolvedValue(0);
    const roomy = await setupScenario(db, { ...scenario });
    expect(
      await reconcileCompletionStates(db, { checkPid: () => true, checkCommits: async () => true, now: new Date().toISOString() }),
    ).toBe(1);
    const [reaped] = await db.select().from(sessions).where(eq(sessions.id, roomy.sessionId)).limit(1);
    expect(reaped.status).toBe("stopped");

    // Saturated host: the same numbers, windows doubled to 30 min / 60 min — held.
    const busyDb = createTestDb().db;
    const saturated = await setupScenario(busyDb, { ...scenario });
    cpuBusyPct.mockResolvedValue(99);
    expect(
      await reconcileCompletionStates(busyDb, { checkPid: () => true, checkCommits: async () => true, now: new Date().toISOString() }),
    ).toBe(0);
    const [held] = await busyDb.select().from(sessions).where(eq(sessions.id, saturated.sessionId)).limit(1);
    expect(held.status).toBe("running");
    cpuBusyPct.mockResolvedValue(0);
  });

  // ─── a reaped REVIEW session gets its review back (#1212) ────────────────────

  it("re-queues the review once and comments on the ticket when it reaps a review session", async () => {
    const silent = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const { workspaceId, issueId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      sessionTriggerType: "review",
      workspaceUpdatedAt: silent,
      sessionStartedAt: silent,
      lastOutputAt: silent,
    });
    const requeueReview = vi.fn(async () => ({ sessionId: "new-review-session" }));

    const count = await reconcileCompletionStates(db, {
      checkPid: () => true,
      checkCommits: async () => true,
      requeueReview,
      now: new Date().toISOString(),
    });

    expect(count).toBe(1);
    expect(requeueReview).toHaveBeenCalledTimes(1);
    expect(requeueReview).toHaveBeenCalledWith(workspaceId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("system");
    expect(comments[0].body).toContain("re-queued the review");
    expect(comments[0].body).toContain("new-review-session");
    expect(comments[0].body).toContain("silent for");
  });

  it("does NOT re-queue a review for a reaped BUILDER session", async () => {
    const silent = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const { issueId } = await setupScenario(db, {
      issueStatusName: "In Review",
      workspaceStatus: "active",
      sessionPid: 12345,
      sessionTriggerType: "manual",
      workspaceUpdatedAt: silent,
      sessionStartedAt: silent,
      lastOutputAt: silent,
    });
    const requeueReview = vi.fn(async () => ({ sessionId: "should-not-happen" }));

    const count = await reconcileCompletionStates(db, {
      checkPid: () => true,
      checkCommits: async () => true,
      requeueReview,
      now: new Date().toISOString(),
    });

    expect(count).toBe(1);
    expect(requeueReview).not.toHaveBeenCalled();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });
});
