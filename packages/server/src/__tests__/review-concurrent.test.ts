import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { issues, preferences, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { ReviewError, startManualReview } from "../services/review.service.js";

const mockPrepareForReview = vi.fn(async () => ({ success: true, diffRef: "main", conflictingFiles: [], uncommittedChanges: [] }));
vi.mock("../services/git.service.js", () => ({
  prepareForReview: (...args: unknown[]) => mockPrepareForReview(...args),
}));

const mockBoardEvents = { broadcast: vi.fn() };

function makeSessionManager(sessionIdFn: () => string | Promise<string> = () => randomUUID()) {
  return {
    startSession: vi.fn(async () => sessionIdFn()),
    stopSession: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
}

async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"], overrides: Partial<typeof workspaces.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Test issue", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-1-test",
    workingDir: null,
    isDirect: true,
    baseBranch: "main",
    status: "idle",
    createdAt: now, updatedAt: now,
    ...overrides,
  });
  await db.insert(preferences).values({ key: "claude_profile", value: "mock" });

  return { workspaceId, projectId, issueId };
}

async function seedReviewUsageLimitSession(
  db: ReturnType<typeof createTestDb>["db"],
  workspaceId: string,
  overrides: Partial<typeof sessions.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    workspaceId,
    executor: "claude-code",
    status: "stopped",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: now,
    exitCode: "1",
    triggerType: "review",
    stats: JSON.stringify({
      durationMs: 1000,
      success: false,
      launchFailure: true,
      rateLimited: true,
      rateLimitKind: "claude-usage-limit",
      failureReason: "Claude usage limit reached. Your limit will reset at 3pm.",
    }),
    ...overrides,
  });
  return sessionId;
}

describe("startManualReview — concurrent trigger hardening (AK-520)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    mockBoardEvents.broadcast.mockClear();
    mockPrepareForReview.mockReset();
    mockPrepareForReview.mockResolvedValue({ success: true, diffRef: "main", conflictingFiles: [], uncommittedChanges: [] });
  });

  it("succeeds and returns a sessionId for a single idle workspace", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const sessionManager = makeSessionManager(() => "session-ok");
    const reviewSessionIds = new Set<string>();

    const result = await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);

    expect(result.sessionId).toBe("session-ok");
    expect(reviewSessionIds.has("session-ok")).toBe(true);
  });

  it("returns 409 ReviewError (not a bare throw) when workspace is not idle", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "reviewing" });
    const sessionManager = makeSessionManager();
    const reviewSessionIds = new Set<string>();

    await expect(
      startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReviewError && err.code === "CONFLICT");
  });

  it("recovers a blocked review rate-limit failure and uses the current board default provider/profile", async () => {
    const { workspaceId } = await seedWorkspace(db, {
      status: "blocked",
      provider: "claude",
      claudeProfile: "anth",
    });
    await seedReviewUsageLimitSession(db, workspaceId);
    await db.delete(preferences);
    await db.insert(preferences).values([
      { key: "provider", value: "codex" },
      { key: "claude_profile", value: "anth" },
      { key: "codex_profile", value: "default" },
    ]);
    const sessionManager = makeSessionManager(() => "session-recovered");
    const reviewSessionIds = new Set<string>();

    const result = await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);

    expect(result.sessionId).toBe("session-recovered");
    expect(sessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      profile: { provider: "codex", name: "default" },
      triggerType: "review",
    }));
  });

  it("recovers a blocked review rate-limit failure with the Strategy Bullseye default when settings diverge", async () => {
    const { workspaceId, projectId } = await seedWorkspace(db, {
      status: "blocked",
      provider: "claude",
      claudeProfile: "anth",
    });
    await seedReviewUsageLimitSession(db, workspaceId);
    await db.delete(preferences);
    await db.insert(preferences).values([
      { key: "provider", value: "claude" },
      { key: "claude_profile", value: "anth" },
      { key: "codex_profile", value: "default" },
      {
        key: `board_strategy_${projectId}`,
        value: JSON.stringify({
          version: 1,
          providerPolicies: [{ provider: "codex", profileName: "default", mode: "fill" }],
        }),
      },
    ]);
    const sessionManager = makeSessionManager(() => "session-recovered");
    const reviewSessionIds = new Set<string>();

    await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);

    expect(sessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      profile: { provider: "codex", name: "default" },
      triggerType: "review",
    }));
  });

  it("does not recover a blocked workspace while any session is still running", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "blocked" });
    await seedReviewUsageLimitSession(db, workspaceId, {
      id: randomUUID(),
      status: "running",
      endedAt: null,
    });
    const sessionManager = makeSessionManager();
    const reviewSessionIds = new Set<string>();

    await expect(
      startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ReviewError)) return false;
      expect(err.code).toBe("CONFLICT");
      expect(err.details).toMatchObject({ retryable: false, reason: "active_session" });
      return true;
    });

    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("concurrent review triggers: second call gets CONFLICT, not an uncaught 500", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const reviewSessionIds = new Set<string>();

    // First session manager hangs until we resolve it
    let resolveSession!: (id: string) => void;
    const slowSession = new Promise<string>((resolve) => { resolveSession = resolve; });
    const sessionManager = makeSessionManager(() => slowSession);

    // Fire two concurrent requests before the first has set status="reviewing"
    const first = startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);
    const second = startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);

    // Second must reject with CONFLICT immediately (in-flight guard)
    await expect(second).rejects.toSatisfy(
      (err: unknown) => err instanceof ReviewError && err.code === "CONFLICT",
    );

    // Resolve the first so the test doesn't hang
    resolveSession("session-first");
    const firstResult = await first;
    expect(firstResult.sessionId).toBe("session-first");
  });

  it("second call after first completes succeeds if workspace reset to idle", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const reviewSessionIds = new Set<string>();
    const sessionManager = makeSessionManager();

    await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);

    // Simulate workspace going back to idle (e.g. after the review session ends)
    await db.update(workspaces).set({ status: "idle" }).where(
      (await import("drizzle-orm")).eq(workspaces.id, workspaceId),
    );

    const second = await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);
    expect(second.sessionId).toBeTruthy();
  });

  it("transient session-manager failure reverts workspace to idle and allows retry", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const reviewSessionIds = new Set<string>();
    const failingManager = makeSessionManager(async () => { throw new Error("EBUSY: sqlite db locked"); });

    await expect(
      startManualReview(db, () => failingManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toThrow("EBUSY");

    // Workspace must be reverted to idle automatically — no manual reset needed
    const { eq } = await import("drizzle-orm");
    const rows = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(rows[0].status).toBe("idle");

    // In-flight guard must be cleared — a retry is immediately possible without touching the DB
    const retryManager = makeSessionManager(() => "session-retry");
    const retryResult = await startManualReview(db, () => retryManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);
    expect(retryResult.sessionId).toBe("session-retry");
  });

  it("launch-failure revert cannot flip a concurrently merged (closed+mergedAt) workspace back to idle (#985)", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const reviewSessionIds = new Set<string>();
    const { eq } = await import("drizzle-orm");
    const mergedAt = new Date().toISOString();

    // Session manager fails to launch — but before it throws, a concurrent merge
    // lands the workspace as closed+mergedAt (terminal). The revert-to-idle in the
    // catch path must go through the terminal-invariant authority and no-op.
    const racingManager = makeSessionManager(async () => {
      await db.update(workspaces)
        .set({ status: "closed", mergedAt })
        .where(eq(workspaces.id, workspaceId));
      throw new Error("launch failed after merge landed");
    });

    await expect(
      startManualReview(db, () => racingManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toThrow("launch failed");

    const rows = await db
      .select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    expect(rows[0].status).toBe("closed");
    expect(rows[0].mergedAt).toBe(mergedAt);
  });
});

/** Seed a non-direct (worktree) workspace with a workingDir so prepareForReview is called. */
async function seedWorktreeWorkspace(db: ReturnType<typeof createTestDb>["db"], overrides: Partial<typeof workspaces.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Test issue", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-1-test",
    workingDir: "/tmp/worktree",
    isDirect: false,
    baseBranch: "main",
    status: "idle",
    createdAt: now, updatedAt: now,
    ...overrides,
  });
  await db.insert(preferences).values({ key: "claude_profile", value: "mock" });

  return { workspaceId, projectId, issueId };
}

describe("startManualReview — preflight rebase conflict returns structured 409 (#662)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    mockBoardEvents.broadcast.mockClear();
    mockPrepareForReview.mockReset();
    mockPrepareForReview.mockResolvedValue({ success: true, diffRef: "main", conflictingFiles: [], uncommittedChanges: [] });
  });

  it("throws ReviewError CONFLICT with conflictFiles when prepareForReview fails with conflicts", async () => {
    const { workspaceId } = await seedWorktreeWorkspace(db);
    mockPrepareForReview.mockResolvedValue({
      success: false,
      diffRef: "main",
      conflictingFiles: ["src/foo.ts", "src/bar.ts"],
      error: "CONFLICT (content): Merge conflict in src/foo.ts",
    });

    const sessionManager = makeSessionManager();
    const reviewSessionIds = new Set<string>();

    await expect(
      startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ReviewError)) return false;
      if (err.code !== "CONFLICT") return false;
      if (!err.details?.conflictFiles) return false;
      if (err.details.conflictFiles.length !== 2) return false;
      if (!err.message.includes("2 file(s) conflict")) return false;
      return true;
    });

    // No session should have been launched
    expect(sessionManager.startSession).not.toHaveBeenCalled();
    // In-flight guard must be cleared — a retry is possible
    expect(reviewSessionIds.size).toBe(0);
  });

  it("blocked rate-limit recovery still returns structured conflict details when review preflight conflicts", async () => {
    const { workspaceId } = await seedWorktreeWorkspace(db, {
      status: "blocked",
      provider: "claude",
      claudeProfile: "anth",
    });
    await seedReviewUsageLimitSession(db, workspaceId);
    mockPrepareForReview.mockResolvedValue({
      success: false,
      diffRef: "main",
      conflictingFiles: ["src/conflict.ts"],
      error: "CONFLICT (content): Merge conflict in src/conflict.ts",
    });

    const sessionManager = makeSessionManager();
    const reviewSessionIds = new Set<string>();

    await expect(
      startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ReviewError)) return false;
      expect(err.code).toBe("CONFLICT");
      expect(err.details?.conflictFiles).toEqual(["src/conflict.ts"]);
      expect(err.message).toContain("1 file(s) conflict");
      return true;
    });

    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("throws ReviewError CONFLICT when prepareForReview fails without explicit conflict files", async () => {
    const { workspaceId } = await seedWorktreeWorkspace(db);
    mockPrepareForReview.mockResolvedValue({
      success: false,
      diffRef: "main",
      conflictingFiles: [],
      error: "some unexpected rebase failure",
    });

    const sessionManager = makeSessionManager();
    const reviewSessionIds = new Set<string>();

    await expect(
      startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ReviewError)) return false;
      if (err.code !== "CONFLICT") return false;
      if (!err.message.includes("unexpected rebase failure")) return false;
      return true;
    });

    expect(sessionManager.startSession).not.toHaveBeenCalled();
  });

  it("workspace stays idle after preflight conflict (not stuck at reviewing)", async () => {
    const { workspaceId } = await seedWorktreeWorkspace(db);
    mockPrepareForReview.mockResolvedValue({
      success: false,
      diffRef: "main",
      conflictingFiles: ["src/conflict.ts"],
      error: "CONFLICT",
    });

    const sessionManager = makeSessionManager();
    const reviewSessionIds = new Set<string>();

    try {
      await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);
    } catch { /* expected */ }

    // Workspace must NOT have been moved to "reviewing"
    const { eq } = await import("drizzle-orm");
    const rows = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    expect(rows[0].status).toBe("idle");
  });

  it("retry succeeds after preflight conflict is resolved", async () => {
    const { workspaceId } = await seedWorktreeWorkspace(db);
    const sessionManager = makeSessionManager(() => "session-retry");
    const reviewSessionIds = new Set<string>();

    // First call: preflight fails
    mockPrepareForReview.mockResolvedValueOnce({
      success: false,
      diffRef: "main",
      conflictingFiles: ["src/conflict.ts"],
      error: "CONFLICT",
    });

    await expect(
      startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false),
    ).rejects.toThrow();

    // Second call: preflight succeeds
    mockPrepareForReview.mockResolvedValueOnce({
      success: true,
      diffRef: "main",
      conflictingFiles: [],
      uncommittedChanges: [],
    });

    const result = await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);
    expect(result.sessionId).toBe("session-retry");
  });

  it("direct workspace (no workingDir) skips prepareForReview entirely", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const sessionManager = makeSessionManager(() => "session-direct");
    const reviewSessionIds = new Set<string>();

    const result = await startManualReview(db, () => sessionManager as never, mockBoardEvents as never, reviewSessionIds, workspaceId, false);
    expect(result.sessionId).toBe("session-direct");
    expect(mockPrepareForReview).not.toHaveBeenCalled();
  });
});
