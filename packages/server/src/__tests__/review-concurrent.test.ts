import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { ReviewError, startManualReview } from "../services/review.service.js";

vi.mock("../services/git.service.js", () => ({
  prepareForReview: vi.fn(async () => ({ success: true, diffRef: "main", conflictingFiles: [], uncommittedChanges: [] })),
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

async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"], overrides: { status?: string } = {}) {
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
    status: overrides.status ?? "idle",
    createdAt: now, updatedAt: now,
  });
  await db.insert(preferences).values({ key: "claude_profile", value: "mock" });

  return { workspaceId, projectId, issueId };
}

describe("startManualReview — concurrent trigger hardening (AK-520)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    mockBoardEvents.broadcast.mockClear();
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
});
