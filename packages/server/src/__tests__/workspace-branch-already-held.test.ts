// @covers workspaces.create.branch-held-by-live-workspace [observability]
//
// #394 aggravating detail 2: eventhub's issue #92 had TWO workspaces created 47s apart and #93
// two created 110s apart, and in each pair BOTH rows carried the same `working_dir`
// (`exp/.worktrees/ak-92`, `exp/.worktrees/ak-93`). Git allows exactly one worktree per branch, so
// `createWorktree` adopted the existing one and the second row could never own that directory.
// All four were born `blocked`; the worktrees existed and were registered, so the failure happened
// AFTER worktree creation.
//
// #394 asked for a REFUSAL and it cannot be one. Co-residency on a shared worktree is a SUPPORTED
// state here: the service-stack adoption path exists precisely so a second workspace on an
// occupied worktree adopts the senior co-resident's stack instead of racing it for
// `.kanban/services.env` (see `workspace.service.test.ts`, "ADOPTS a live co-resident's stack on a
// shared worktree"). From the rows alone a deliberate co-resident and an accidental retry
// collision are identical, so a refusal would break a working flow to catch a bug it cannot
// distinguish. What WAS missing is any record that the sharing happened — the eventhub pairs
// looked like ordinary independent workspaces. Hence: the create proceeds, and says so.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
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
    id: issueId, issueNumber: 92, title: "Branch held by a live workspace", description: null,
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return { projectId, issueId };
}

describe("a create landing on a branch a live workspace holds (#394)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let warnings: string[];

  beforeEach(() => {
    ({ db } = createTestDb());
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function service() {
    return createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({ startSession: vi.fn(async () => "sid"), stopSession: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }) as never,
      gitService: makeGitService() as never,
    });
  }

  async function createOnBranch(issueId: string) {
    return service().createWorkspace({
      issueId, branch: "feature/ak-92-x", isDirect: false, requiresReview: false, thoroughReview: false,
      planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
    });
  }

  async function createSecond(existingStatus: string | null) {
    const { issueId } = await seedIssue(db);
    const holderId = randomUUID();
    if (existingStatus) {
      const now = new Date().toISOString();
      await db.insert(workspaces).values({
        id: holderId, issueId, branch: "feature/ak-92-x", workingDir: "/tmp/worktrees/feature/ak-92-x",
        baseBranch: "main", isDirect: false, status: existingStatus, provider: "claude",
        createdAt: now, updatedAt: now,
      });
    }
    return { created: await createOnBranch(issueId), issueId, holderId };
  }

  it("still creates the workspace — co-residency is a supported state, not an error", async () => {
    const { created, issueId } = await createSecond("active");
    expect(created.id).toBeTruthy();
    const rows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(rows).toHaveLength(2);
  });

  it("names the holder and the branch, so the sharing is on the record", async () => {
    const { holderId } = await createSecond("active");
    const line = warnings.find((w) => w.includes("already held by"));
    expect(line).toBeTruthy();
    expect(line).toContain("feature/ak-92-x");
    expect(line).toContain(holderId);
  });

  it("warns for an idle or blocked holder too — a non-closed row still owns the worktree", async () => {
    // The eventhub pairs were both `blocked`.
    await createSecond("blocked");
    expect(warnings.some((w) => w.includes("already held by"))).toBe(true);
    warnings.length = 0;
    await createSecond("idle");
    expect(warnings.some((w) => w.includes("already held by"))).toBe(true);
  });

  it("stays silent when the previous workspace on the branch is CLOSED", async () => {
    const { issueId } = await seedIssue(db);
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: randomUUID(), issueId, branch: "feature/ak-92-x", workingDir: null, baseBranch: "main",
      isDirect: false, status: "closed", provider: "claude", createdAt: now, updatedAt: now,
    });
    await createOnBranch(issueId);
    expect(warnings.some((w) => w.includes("already held by"))).toBe(false);
  });

  it("stays silent when nothing holds the branch", async () => {
    await createSecond(null);
    expect(warnings.some((w) => w.includes("already held by"))).toBe(false);
  });
});
