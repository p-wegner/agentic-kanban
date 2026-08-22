// @covers workspaces.create.branch-create-claim [error]
//
// #673 item 1: issue #670 held TWO open workspace records, created 9 seconds apart by two
// different starters (the monitor auto-start and a manual `POST /api/workspaces`), on the
// SAME branch and sharing one worktree — the monitor relaunched both, running two agents
// concurrently in one working directory. `auto-start-claim.ts` (#366) already serializes
// AUTOMATIC starters against each other by issueId, but explicitly exempts anything that
// isn't an automatic starter, so a manual create racing an automatic one (or two manual
// creates) for the SAME issue's default branch was never guarded. This test exercises the
// CONCURRENT path (two overlapping createWorkspace calls, not two sequential ones) and
// asserts exactly one wins.
//
// #719 re-keyed that claim from `(issueId, branch)` onto the worktree PATH, and this file's
// mock is why the mis-keying was invisible: it returned `/tmp/worktrees/<branch>`, a
// PER-BRANCH path production never produces. `createWorktree` collapses every branch of
// issue N to the leaf `ak-N`, so two branches of one issue share one directory — and the
// second test below asserted, as intended behaviour, that such a pair is allowed to race.
// The mock now derives the leaf with the real `worktreeDirLeafForBranch`, so a test can no
// longer assume a collision away.
//
// #736 threads `repoPath` into the claim so the key is the FULL resolved path rather than
// `issueId + leaf`, which closes the cross-issue case exercised below (an explicit branch
// naming ANOTHER issue's number), and rewords the 409 to name the directory both creates
// resolve to instead of claiming "same-issue/same-branch".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { worktreeDirLeafForBranch } from "@agentic-kanban/shared/lib/git-service";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";
import { resetBranchCreateClaims } from "../services/workspace-branch-create-claim.js";

/**
 * The path `createWorktree` would resolve to for this repo+branch: the real
 * `<parent>/.worktrees/<repoDirName>/<leaf>` shape, with the real leaf derivation. Only the
 * on-disk work is skipped.
 */
function derivedWorktreePath(repoPath: string, branch: string): string {
  return join(dirname(repoPath), ".worktrees", basename(repoPath), worktreeDirLeafForBranch(branch));
}

function makeGitService(overrides: Record<string, unknown> = {}) {
  return {
    createWorktree: vi.fn(async (repo: string, branch: string) => derivedWorktreePath(repo, branch)),
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
    id: issueId, issueNumber: 670, title: "Two workspaces for one issue", description: null,
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return { projectId, statusId, issueId };
}

/** A second issue in the SAME project (hence the same repo, hence one `.worktrees` subtree). */
async function seedSiblingIssue(
  db: ReturnType<typeof createTestDb>["db"],
  seeded: { projectId: string; statusId: string },
  issueNumber: number,
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber, title: "Another issue in the same repo", description: null,
    priority: "medium", sortOrder: 1, statusId: seeded.statusId, projectId: seeded.projectId,
    createdAt: now, updatedAt: now,
  });
  return issueId;
}

describe("createWorkspace refuses a concurrent same-issue/same-branch race (#673)", () => {
  beforeEach(() => {
    resetBranchCreateClaims();
  });

  afterEach(() => {
    resetBranchCreateClaims();
  });

  it("lets exactly one of two overlapping creates for the same issue+default-branch win", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

    const git = makeGitService();
    const sessionManager = {
      startSession: vi.fn(async () => "session-id"),
      stopSession: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => sessionManager as never,
      gitService: git as never,
    });

    const makeInput = () => ({
      issueId, isDirect: false, requiresReview: false, thoroughReview: false,
      planMode: false, tddMode: false, includeVisualProof: false,
      skipSetup: true, skipContextPacker: true,
    });

    // Neither call passes an explicit `branch` — both derive the SAME default branch via
    // suggestBranchName(issue), reproducing #670's real-world collision. Fired concurrently
    // (no sequential await between them), the way the monitor auto-start and a manual POST
    // actually overlapped.
    const results = await Promise.allSettled([
      svc.createWorkspace(makeInput()),
      svc.createWorkspace(makeInput()),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already in flight"),
      data: expect.objectContaining({ code: "BRANCH_CREATE_IN_FLIGHT", issueId }),
    });

    // Only ONE workspace row landed for the issue — no shared-worktree duplicate.
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(1);

    // The loser's branch is free again afterward — a genuine retry (or a deliberate second
    // workspace on a different branch) is not permanently blocked by the failed race.
    const retry = await svc.createWorkspace(makeInput());
    expect(retry.id).not.toBe(wsRows[0].id);
  });

  // #719: this test used to assert the OPPOSITE — that two branches of one issue may race,
  // the "provider showdown" exemption #673 wrote down as intended behaviour. Both branches
  // collapse to the leaf `ak-670`, so that pair is exactly the one that contends on ONE
  // directory, which is what #670 actually was. It reads as an exemption only while the git
  // mock hands out a per-branch path.
  it("refuses two branches of one issue racing, because both resolve to the SAME worktree", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

    const git = makeGitService();
    const sessionManager = {
      startSession: vi.fn(async () => "session-id"),
      stopSession: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => sessionManager as never,
      gitService: git as never,
    });

    // The premise, stated as an assertion so this test cannot quietly stop being about a
    // collision if the leaf derivation changes.
    expect(derivedWorktreePath("/tmp/repo", "feature/ak-670-a"))
      .toBe(derivedWorktreePath("/tmp/repo", "feature/ak-670-b"));

    const results = await Promise.allSettled([
      svc.createWorkspace({
        issueId, isDirect: false, branch: "feature/ak-670-a", requiresReview: false, thoroughReview: false,
        planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
      }),
      svc.createWorkspace({
        issueId, isDirect: false, branch: "feature/ak-670-b", requiresReview: false, thoroughReview: false,
        planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      data: expect.objectContaining({
        code: "BRANCH_CREATE_IN_FLIGHT",
        issueId,
        worktreePath: derivedWorktreePath("/tmp/repo", "feature/ak-670-a"),
      }),
    });
    // #736 gap 3: this caller passed a DELIBERATELY different branch, so the old message
    // ("Same-issue/same-branch is never a deliberate second workspace") denied what had just
    // happened to them. The refusal must name the resource that actually collided.
    const message = (rejected[0] as PromiseRejectedResult).reason.message as string;
    expect(message).toContain("worktree directory");
    expect(message).toContain(derivedWorktreePath("/tmp/repo", "feature/ak-670-a"));
    expect(message).not.toContain("same-branch");
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(1);
  });

  // The exemption #366/#673 wanted, expressed on the resource that actually decides it: two
  // creates for one issue whose branches resolve to DIFFERENT directories are still both
  // allowed to run concurrently. `showdown/codex` carries no `ak-<n>`, so it keeps its full
  // sanitized leaf instead of collapsing onto `ak-670`.
  it("does NOT block a second workspace for the same issue on a branch with a DIFFERENT worktree", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);

    const git = makeGitService();
    const sessionManager = {
      startSession: vi.fn(async () => "session-id"),
      stopSession: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => sessionManager as never,
      gitService: git as never,
    });

    expect(derivedWorktreePath("/tmp/repo", "feature/ak-670-a"))
      .not.toBe(derivedWorktreePath("/tmp/repo", "showdown/codex"));

    const results = await Promise.allSettled([
      svc.createWorkspace({
        issueId, isDirect: false, branch: "feature/ak-670-a", requiresReview: false, thoroughReview: false,
        planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
      }),
      svc.createWorkspace({
        issueId, isDirect: false, branch: "showdown/codex", requiresReview: false, thoroughReview: false,
        planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.issueId, issueId));
    expect(wsRows).toHaveLength(2);
  });

  // #736 gap 1: the residual hole #719 left open. Its key was `issueId + leaf`, so ANOTHER
  // issue's create on an explicit branch carrying issue 670's number got a DIFFERENT key for
  // the SAME directory and was granted — the exact destructive race this guard exists for,
  // just across two issues of one project instead of two branches of one issue.
  it("refuses another issue's create whose explicit branch resolves to THIS issue's worktree", async () => {
    const { db } = createTestDb();
    const seeded = await seedIssue(db);
    const otherIssueId = await seedSiblingIssue(db, seeded, 812);

    const git = makeGitService();
    const sessionManager = {
      startSession: vi.fn(async () => "session-id"),
      stopSession: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const svc = createWorkspaceCrudService({
      database: db,
      getSessionManager: () => sessionManager as never,
      gitService: git as never,
    });

    // The premise, asserted so the test cannot quietly stop being about a collision: the two
    // issues' branches resolve to ONE directory, because the leaf comes from the branch.
    expect(derivedWorktreePath("/tmp/repo", "feature/ak-670-a"))
      .toBe(derivedWorktreePath("/tmp/repo", "feature/ak-670-typo"));

    const results = await Promise.allSettled([
      svc.createWorkspace({
        issueId: seeded.issueId, isDirect: false, branch: "feature/ak-670-a", requiresReview: false,
        thoroughReview: false, planMode: false, tddMode: false, includeVisualProof: false,
        skipSetup: true, skipContextPacker: true,
      }),
      svc.createWorkspace({
        issueId: otherIssueId, isDirect: false, branch: "feature/ak-670-typo", requiresReview: false,
        thoroughReview: false, planMode: false, tddMode: false, includeVisualProof: false,
        skipSetup: true, skipContextPacker: true,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      data: expect.objectContaining({
        code: "BRANCH_CREATE_IN_FLIGHT",
        worktreePath: derivedWorktreePath("/tmp/repo", "feature/ak-670-a"),
      }),
    });
    // Exactly one workspace row landed across BOTH issues — no shared-worktree duplicate.
    const allRows = await db.select().from(workspaces);
    expect(allRows).toHaveLength(1);
  });
});
