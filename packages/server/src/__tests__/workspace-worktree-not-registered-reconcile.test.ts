// @covers workspaces.create.worktree-not-registered-reconcile [observability]
//
// #673 defect 2: issue #670's workspace records carried a workingDir that was NOT a registered
// git worktree — `git worktree list` had only `ak-670-2` on that branch, `ak-670` was a leftover
// directory. That mismatch surfaced later as an opaque "blocking setup script failed (exit 1)",
// because the setup script ran against a directory git itself did not recognize. This should be
// a LOUD reconcile signal at create time instead of a silent failure discovered downstream.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";

function makeGitService(overrides: Record<string, unknown> = {}) {
  return {
    createWorktree: vi.fn(async (_repo: string, branch: string) => `/tmp/worktrees/${branch}`),
    removeWorktree: vi.fn(async () => {}),
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadCommitSha: vi.fn(async () => "abc123"),
    revParse: vi.fn(async () => "abc123"),
    pruneWorktrees: vi.fn(async () => {}),
    listWorktrees: vi.fn(async () => []),
    ensureOnBranch: vi.fn(async () => {}),
    ...overrides,
  };
}

async function seedIssue(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test Project", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 670, title: "Worktree not registered", description: null,
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return { projectId, issueId };
}

describe("workspace create reconciles when the assigned workingDir isn't a registered worktree (#673)", () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs RECONCILE when git worktree list doesn't include the assigned workingDir", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

    // git knows about a DIFFERENT path than the one createWorktree just returned/assigned —
    // reproducing #670's real-world state.
    const git = makeGitService({
      listWorktrees: vi.fn(async () => [{ path: "/tmp/worktrees/feature/ak-670-x-2", branch: "feature/ak-670-x" }]),
    });
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({ startSession: vi.fn(async () => "sid"), stopSession: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }) as never,
      gitService: git as never,
    });

    await svc.createWorkspace({
      issueId, branch: "feature/ak-670-x", isDirect: false, requiresReview: false, thoroughReview: false,
      planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
    });

    expect(errors.some((e) => e.includes("RECONCILE") && e.includes("feature/ak-670-x"))).toBe(true);
  });

  it("stays silent when the assigned workingDir IS registered", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

    const git = makeGitService({
      listWorktrees: vi.fn(async () => [{ path: "/tmp/worktrees/feature/ak-670-x", branch: "feature/ak-670-x" }]),
    });
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({ startSession: vi.fn(async () => "sid"), stopSession: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }) as never,
      gitService: git as never,
    });

    await svc.createWorkspace({
      issueId, branch: "feature/ak-670-x", isDirect: false, requiresReview: false, thoroughReview: false,
      planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
    });

    expect(errors.some((e) => e.includes("RECONCILE"))).toBe(false);
  });

  it("stays silent when the mocked git service reports no worktrees at all (can't verify, don't false-flag)", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

    const git = makeGitService(); // default listWorktrees -> []
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({ startSession: vi.fn(async () => "sid"), stopSession: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }) as never,
      gitService: git as never,
    });

    await svc.createWorkspace({
      issueId, branch: "feature/ak-670-x", isDirect: false, requiresReview: false, thoroughReview: false,
      planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
    });

    expect(errors.some((e) => e.includes("RECONCILE"))).toBe(false);
  });
});
