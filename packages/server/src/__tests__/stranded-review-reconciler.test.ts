/**
 * Regression tests for the stranded-review reconciler's hot-reload-safe disable path (#582).
 *
 * Verifies that disabling the reconciler via the `enabled` dep or DB preference
 * causes zero mutations on the next tick — even if an old setInterval handle
 * (kept alive by tsx --watch) keeps firing.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileStrandedReviews } from "../startup/stranded-review-reconciler.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

function makeDeps(db: ReturnType<typeof createTestDb>["db"], overrides: { enabled?: boolean } = {}) {
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

async function seedStrandedWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 582,
    title: "Stranded",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-582-test",
    workingDir: "/repo/.worktrees/ws",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: false,
    mergedAt: null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, inReviewStatusId };
}

describe("reconcileStrandedReviews — disable path (regression #582)", () => {
  it("performs zero mutations when disabled via deps.enabled=false", async () => {
    const { db } = createTestDb();
    await seedStrandedWorkspace(db);

    const count = await reconcileStrandedReviews(makeDeps(db, { enabled: false }));

    expect(count).toBe(0);
  });

  it("performs zero mutations when disabled via DB preference", async () => {
    // Regression guard for the hot-reload scenario: a stale setInterval from a
    // pre-edit module closure reads the live pref and no-ops — no restart needed.
    const { db } = createTestDb();
    await seedStrandedWorkspace(db);

    const now = new Date().toISOString();
    await db.insert(preferences)
      .values({ key: "reconciler_stranded_review_enabled", value: "false", updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });

    const count = await reconcileStrandedReviews(makeDeps(db));

    expect(count).toBe(0);
  });
});
