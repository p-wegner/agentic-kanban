// Shared setup + fixtures for the per-resource api-*.test.ts suites.
//
// arch-review 2026-07-07 §1.4: the monolithic api.test.ts (2960 lines / 104 tests /
// 80 commits/90d) was one of the two worst parallel-agent merge-conflict magnets in the
// repo. It was split by resource into api-<resource>.test.ts files; this module holds the
// common test-app builders + DB fixtures they all import, so the setup lives in ONE place
// instead of being duplicated per file. Pure mechanical extraction — no behavior change.
import { createRoutes } from "../../routes/index.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./test-app.js";
import { createMockSessionManager } from "./mocks.js";
import type { TestDb } from "./test-db.js";
import { createBoardEvents } from "../../services/board-events.js";

export function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api", createRoutes(db, () => createMockSessionManager()));
  });
}

export function createTestAppWithBoardEvents() {
  return _createTestApp((app, db) => {
    const boardEvents = createBoardEvents();
    app.route("/api", createRoutes(db, () => createMockSessionManager(), { boardEvents }));
  });
}

// Helper: create a project directly in DB (bypassing git-info detection)
export async function createProjectDirectly(database: TestDb, overrides: {
  name?: string;
  repoPath?: string;
  setupScript?: string | null;
  setupBlocking?: boolean;
  setupEnabled?: boolean;
  defaultBranch?: string | null;
} = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projects).values({
    id,
    name: overrides.name || "Test Project",
    repoPath: overrides.repoPath || "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: overrides.defaultBranch === undefined ? "main" : overrides.defaultBranch,
    setupScript: overrides.setupScript,
    setupBlocking: overrides.setupBlocking,
    setupEnabled: overrides.setupEnabled,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function createStatusDirectly(database: TestDb, projectId: string, name: string, sortOrder: number) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.insert(schema.projectStatuses).values({
    id,
    projectId,
    name,
    sortOrder,
    isDefault: sortOrder === 0,
    createdAt: now,
  });
  return id;
}
