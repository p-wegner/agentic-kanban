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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Default fixture repo for createProjectDirectly — a REAL, throwaway git repo created
// lazily once per test process (vitest fork).
//
// This used to be the hardcoded machine-global path "/tmp/test-repo" (C:\tmp\test-repo
// on Windows), which the tests never seeded: every suite that exercised real git against
// the default project (api-workspace, api-diff) silently depended on a hand-created repo
// pre-existing on the developer's machine, and failed forever on any machine without one
// ("git rev-parse main failed: fatal: not a git repository"). Worse, the on-disk repo
// merge lock (repo-lock.ts) fabricates `<repoPath>/.git` via mkdirSync when missing, so
// unit-test merges against the fake path left an empty .git shell at C:\tmp\test-repo
// that looked like a destroyed repository.
//
// The repo is nested one level inside the mkdtemp parent so worktrees created by the
// product code (`dirname(repoPath)/.worktrees/...`) land inside the same throwaway
// parent — hermetic per process, no cross-suite or cross-run collisions in os.tmpdir().
//
// #364: the parent is removed on process exit. Before this there was no teardown of any kind —
// one `kanban-api-fixture-*` directory leaked per FORK of every `api-*.test.ts` suite, plus every
// `.worktrees` entry the product code created inside it. That made this the single largest
// contributor to the measured 8,448 live `kanban-*` dirs. An `exit` hook rather than an
// `afterAll` because the repo is a per-process lazy singleton shared by ~10 suites: whichever
// suite finished first would otherwise delete the repo the others are still using.
let fixtureRepoPath: string | null = null;
let fixtureRepoParent: string | null = null;
let fixtureExitHookInstalled = false;
export function ensureFixtureRepo(): string {
  if (fixtureRepoPath && existsSync(join(fixtureRepoPath, ".git", "HEAD"))) {
    return fixtureRepoPath;
  }
  const parent = mkdtempSync(join(tmpdir(), "kanban-api-fixture-"));
  fixtureRepoParent = parent;
  if (!fixtureExitHookInstalled) {
    fixtureExitHookInstalled = true;
    process.on("exit", () => {
      if (!fixtureRepoParent) return;
      try {
        // Best-effort: on Windows a git worktree admin file or a just-exited child can still
        // hold this open, and #352 established that is a real cause here rather than a
        // hypothetical. The globalSetup sweep reaps whatever survives on the next run.
        rmSync(fixtureRepoParent, { recursive: true, force: true, maxRetries: 1 });
      } catch { /* the globalSetup sweep is the backstop */ }
    });
  }
  const repoPath = join(parent, "test-repo");
  mkdirSync(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(join(repoPath, "README.md"), "api test fixture\n", "utf8");
  git("add", "README.md");
  git("commit", "-m", "initial commit");
  fixtureRepoPath = repoPath;
  return repoPath;
}

/**
 * Create a project directly in the DB (bypassing git-info detection), with NO status
 * columns — its callers compose bespoke, minimal status sets via `createStatusDirectly`.
 *
 * Deliberately NOT routed through `buildProjectStatusRows` (#563): seeding the full
 * production topology here would add columns the board-endpoint assertions in its 13
 * callers do not expect, for no gain — those tests are not about the status topology.
 * The helpers that DO mean to seed a whole project (`workflow-test-helpers.seedProject`,
 * the mcp-server `seed.ts`, `cli.test.ts`) go through the shared builder instead.
 */
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
    repoPath: overrides.repoPath || ensureFixtureRepo(),
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
