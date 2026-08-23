/**
 * #399 (decision 014) — the workspace-summary git projection.
 *
 * Acceptance, tested at the git-exec SEAM (the only sanctioned git spawn point, #398),
 * so ANY git subprocess — through git.service, the shared git-service, anywhere — is
 * caught, not just the functions the old tests happened to mock:
 *   1. A board build over a FRESH projection does ZERO git spawns on the hot path
 *      (diff/conflict/code-metrics caches fresh too — that is the documented boundary:
 *      those stay SWR-lazy but persisted, so fresh means fully spawn-free).
 *   2. A STALE projection is still served (last-known values, SWR) while a background
 *      refresh writes new facts through to the row — including the chained diff-stat
 *      refresh when HEAD advanced.
 *   3. A merge through the board's own merge service marks the projection dirty and is
 *      visible in the next summary build without any git spawn (no full git rebuild).
 *   4. A workspace mutated outside the board (simulated by marking dirty) is healed by
 *      the bounded reconcile pass.
 *   5. `setWorkspaceStatus` — the single status authority — marks the projection dirty.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { issues, projects, projectStatuses, workspaceCodeMetrics, workspaceConflictCache, workspaceSummary, workspaces } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { createTestDb } from "./helpers/test-db.js";
import { makeTempRepo } from "./helpers/temp-repo.js";

// ─── The git-exec seam spy ──────────────────────────────────────────────────
// Every spawn the codebase can make goes through this module (#398). The mock records
// each call and answers from a small canned dispatch, so tests can assert an exact
// spawn count (zero on the hot path) without any real subprocess.
const gitExecCalls: string[][] = [];
function cannedGitOutput(args: string[]): string {
  if (args[0] === "log") return "abc999\tprojected message";
  if (args[0] === "rev-list") return "5";
  if (args[0] === "diff") return " 3 files changed, 10 insertions(+), 2 deletions(-)";
  return "";
}
vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  DEFAULT_GIT_TIMEOUT_MS: 10 * 60_000,
  GIT_CONTROL_OPERATION_LABEL: "git:control",
  GIT_SPAWN_SLOTS: 8,
  GIT_DEDUPE_MEMO_TTL_MS: 1500,
  __resetGitExecSchedulerForTests: () => {},
  gitExec: vi.fn(async (args: string[]) => {
    gitExecCalls.push(args);
    return { stdout: cannedGitOutput(args), stderr: "", code: 0 };
  }),
  gitExecOrThrow: vi.fn(async (args: string[]) => {
    gitExecCalls.push(args);
    return cannedGitOutput(args);
  }),
  gitExecSync: vi.fn((args: string[]) => {
    gitExecCalls.push(args);
    return cannedGitOutput(args);
  }),
  gitStream: vi.fn(() => {
    throw new Error("gitStream not expected in these tests");
  }),
}));

import { buildWorkspaceSummaryMap } from "../services/workspace-summary.service.js";
import {
  healWorkspaceSummaryProjection,
  isGitProjectionFresh,
  ACTIVE_GIT_PROJECTION_TTL_MS,
  IDLE_GIT_PROJECTION_TTL_MS,
} from "../services/workspace-summary-projection.service.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import { activeMerges } from "../services/workspace-internals.js";

const tempDirs: string[] = [];
function makeTempWorktree(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ws-proj-${label}-`));
  // Make it look like a git working tree so isGitWorkingTree() passes without a repo.
  writeFileSync(join(dir, ".git"), "gitdir: /nowhere\n", "utf-8");
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  while (tempDirs.length > 0) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

beforeEach(() => {
  gitExecCalls.length = 0;
  activeMerges.clear();
});

interface SeedOpts {
  status?: string;
  workingDir?: string | null;
  projection?: Partial<{
    summaryHeadSha: string | null;
    summaryHeadMessage: string | null;
    summaryCommitCount: number | null;
    summaryGitRefreshedAt: string | null;
    summaryDirty: boolean;
  }>;
  diffCache?: boolean;
  conflictCache?: boolean;
  statusName?: string;
  repoPath?: string;
  branch?: string;
  readyForMerge?: boolean;
}

async function seed(db: ReturnType<typeof createTestDb>["db"], opts: SeedOpts = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Projection Project",
    repoPath: opts.repoPath ?? "/tmp/projection-project",
    repoName: "projection-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: opts.statusName ?? "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 399,
    title: "Projection issue",
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: opts.branch ?? "feature/ak-399-projection",
    workingDir: opts.workingDir === undefined ? makeTempWorktree("seed") : opts.workingDir,
    baseBranch: "main",
    status: opts.status ?? "idle",
    readyForMerge: opts.readyForMerge ?? false,
    ...(opts.diffCache !== false ? {
      diffStatCacheCheckedAt: now,
      diffStatCacheHeadSha: opts.projection?.summaryHeadSha ?? "abc123",
      diffStatCacheFilesChanged: 2,
      diffStatCacheInsertions: 8,
      diffStatCacheDeletions: 1,
    } : {}),
    createdAt: now,
    updatedAt: now,
  });
  // #815: the git projection lives in `workspace_summary`, not in five `summary_*` columns.
  // It is seeded EXPLICITLY and by default CLEAN, because an absent row reads as DIRTY —
  // that inversion is the whole trap this family carried.
  {
    const p = opts.projection ?? {};
    await db.insert(workspaceSummary).values({
      workspaceId,
      headSha: p.summaryHeadSha !== undefined ? p.summaryHeadSha : "abc123",
      headMessage: p.summaryHeadMessage !== undefined ? p.summaryHeadMessage : "feat: seeded head",
      commitCount: p.summaryCommitCount !== undefined ? p.summaryCommitCount : 3,
      gitRefreshedAt: p.summaryGitRefreshedAt !== undefined ? p.summaryGitRefreshedAt : now,
      dirty: p.summaryDirty !== undefined ? p.summaryDirty : false,
    });
  }
  // #798: fresh code-metrics stamp so no metrics recompute is scheduled — in its own table now.
  await db.insert(workspaceCodeMetrics).values({
    workspaceId, metricsJson: null, computedAt: now,
  });
  // #815: fresh conflict memo so no background probe is scheduled — in its own table now.
  // `conflictCache: false` leaves NO row, which is the "never probed" case.
  if (opts.conflictCache !== false) {
    await db.insert(workspaceConflictCache).values({
      workspaceId, checkedAt: now, hasConflicts: false, files: "[]",
    });
  }
  return { projectId, statusId, doneStatusId, issueId, workspaceId };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("workspace-summary projection — hot path (#399)", () => {
  it("builds the summary with ZERO git spawns when the projection is fresh", async () => {
    const { db } = createTestDb();
    const { issueId } = await seed(db);

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);
    await flush(); // give any (wrongly) scheduled background task a chance to run

    const main = summaryMap.get(issueId)?.main;
    expect(main).toBeTruthy();
    // Served straight from the persisted projection…
    expect(main!.latestCommit).toEqual({ sha: "abc123", message: "feat: seeded head" });
    expect(main!.commitCount).toBe(3);
    expect(main!.diffStats).toEqual({ filesChanged: 2, insertions: 8, deletions: 1 });
    expect(main!.conflicts).toEqual({ hasConflicts: false, conflictingFiles: [] });
    // …and NOTHING went through the git-exec seam.
    expect(gitExecCalls).toEqual([]);
  });

  it("serves last-known values for a stale projection and writes fresh facts through in the background (incl. the HEAD-advance diff chain)", async () => {
    const { db } = createTestDb();
    const staleAt = new Date(Date.now() - IDLE_GIT_PROJECTION_TTL_MS - 60_000).toISOString();
    const { issueId, workspaceId } = await seed(db, {
      projection: { summaryGitRefreshedAt: staleAt },
    });

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db);

    // SWR: the STALE values are what this build serves — no inline spawn, no await.
    const main = summaryMap.get(issueId)?.main;
    expect(main!.latestCommit).toEqual({ sha: "abc123", message: "feat: seeded head" });
    expect(main!.commitCount).toBe(3);

    // Background write-through: new head sha + count land on the row, dirty stays clear,
    // and — since HEAD advanced past the diff cache sha — the diff-stat cache follows.
    await vi.waitFor(async () => {
      const [row] = await db
        .select({
          summaryHeadSha: workspaceSummary.headSha,
          summaryHeadMessage: workspaceSummary.headMessage,
          summaryCommitCount: workspaceSummary.commitCount,
          summaryDirty: workspaceSummary.dirty,
          diffStatCacheHeadSha: workspaces.diffStatCacheHeadSha,
        })
        .from(workspaces)
        .leftJoin(workspaceSummary, eq(workspaceSummary.workspaceId, workspaces.id))
        .where(eq(workspaces.id, workspaceId));
      expect(row.summaryHeadSha).toBe("abc999");
      expect(row.summaryHeadMessage).toBe("projected message");
      expect(row.summaryCommitCount).toBe(5);
      expect(row.summaryDirty).toBe(false);
      expect(row.diffStatCacheHeadSha).toBe("abc999");
    });
    expect(gitExecCalls.length).toBeGreaterThan(0);
  });

  it("does not schedule any refresh for closed or vanished-workingDir workspaces", async () => {
    const { db } = createTestDb();
    const { issueId } = await seed(db, {
      status: "idle",
      workingDir: join(tmpdir(), `ws-proj-vanished-${randomUUID()}`), // never created
      projection: { summaryDirty: true },
    });

    await buildWorkspaceSummaryMap([issueId], "main", db);
    await flush();

    expect(gitExecCalls).toEqual([]);
  });
});

describe("workspace-summary projection — freshness rule", () => {
  it("uses the 30s TTL for active workspaces and the 5-min TTL for idle ones", () => {
    const now = Date.now();
    const at = (ageMs: number) => new Date(now - ageMs).toISOString();
    const base = { summaryDirty: false };
    // Active: fresh under 30s, stale past it.
    expect(isGitProjectionFresh({ ...base, status: "active", summaryGitRefreshedAt: at(ACTIVE_GIT_PROJECTION_TTL_MS - 1000) }, now)).toBe(true);
    expect(isGitProjectionFresh({ ...base, status: "active", summaryGitRefreshedAt: at(ACTIVE_GIT_PROJECTION_TTL_MS + 1000) }, now)).toBe(false);
    // Idle: the same 31s-old stamp is still fresh; past 5 min it is not.
    expect(isGitProjectionFresh({ ...base, status: "idle", summaryGitRefreshedAt: at(ACTIVE_GIT_PROJECTION_TTL_MS + 1000) }, now)).toBe(true);
    expect(isGitProjectionFresh({ ...base, status: "idle", summaryGitRefreshedAt: at(IDLE_GIT_PROJECTION_TTL_MS + 1000) }, now)).toBe(false);
    // Dirty or never-refreshed is never fresh.
    expect(isGitProjectionFresh({ status: "idle", summaryDirty: true, summaryGitRefreshedAt: at(0) }, now)).toBe(false);
    expect(isGitProjectionFresh({ status: "idle", summaryDirty: false, summaryGitRefreshedAt: null }, now)).toBe(false);
  });
});

describe("workspace-summary projection — board events mark dirty", () => {
  it("setWorkspaceStatus stamps the projection dirty on every status write", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, { status: "active" });

    const ok = await setWorkspaceStatus(db, workspaceId, "reviewing", { caller: "test" });
    expect(ok).toBe(true);

    // #815: the flag moved to `workspace_summary`, so this is no longer the same UPDATE as
    // the status write. The guarantee that survives is the one that mattered — the SAME
    // authority stamps it, and only when the status write actually matched a row.
    const [row] = await db.select({ dirty: workspaceSummary.dirty })
      .from(workspaceSummary).where(eq(workspaceSummary.workspaceId, workspaceId));
    expect(row.dirty).toBe(true);
  });

  it("a status write that matches no row (#966 terminal guard) dirties nothing", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, { status: "active" });
    // Land the workspace in the closed+merged terminal state, then clear the flag the close
    // itself set, so the only thing that could re-dirty it is the refused transition below.
    await db.update(workspaces)
      .set({ status: "closed", mergedAt: new Date().toISOString() })
      .where(eq(workspaces.id, workspaceId));
    await db.update(workspaceSummary).set({ dirty: false })
      .where(eq(workspaceSummary.workspaceId, workspaceId));

    const ok = await setWorkspaceStatus(db, workspaceId, "active", { caller: "test" });
    expect(ok).toBe(false);

    const [row] = await db.select({ dirty: workspaceSummary.dirty })
      .from(workspaceSummary).where(eq(workspaceSummary.workspaceId, workspaceId));
    expect(row.dirty).toBe(false);
  });

  it("a merge through the board's merge service dirties the projection and the merged state is served without any git spawn", async () => {
    const { db } = createTestDb();
    const repoPath = makeTempRepo();
    const { issueId, workspaceId } = await seed(db, {
      status: "idle",
      readyForMerge: true,
      statusName: "In Review",
      repoPath,
      branch: "feature/ak-399-merge",
    });

    // Injected git mock — the merge service's own seam (same harness the merge-service
    // suite uses); the projection wiring under test is the DB write, not the git ops.
    let ancestorCalls = 0;
    const git = {
      getDiff: vi.fn(async () => ""),
      getDiffFromRepo: vi.fn(async () => ""),
      revParse: vi.fn(async (_repo: string, ref: string) => (ref === "feature/ak-399-merge" ? "feature-sha" : "base-sha")),
      isAncestor: vi.fn(async () => false),
      mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
      detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
      syncBranchToHead: vi.fn(async () => false),
      abortRebase: vi.fn(async () => {}),
      ensureOnBranch: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      deleteBranch: vi.fn(async () => {}),
      getChangedFilesBetween: vi.fn(async () => []),
      getCurrentBranch: vi.fn(async () => "main"),
      autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
      checkBranchTipIsAncestor: vi.fn(async () => {
        ancestorCalls++;
        if (ancestorCalls === 1) return { isAncestor: false as const, branchSha: "feature-sha", baseSha: "base-sha" };
        return { isAncestor: true as const, branchSha: "feature-sha", baseSha: "merge-sha" };
      }),
      getUncommittedTrackedChanges: vi.fn(async () => []),
      countUniqueCommits: vi.fn(async () => 1),
      rebaseOntoBase: vi.fn(async () => ({ success: true })),
      mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    };

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);
    expect(result.merged).toBe(true);

    // The merge stamped mergedAt AND marked the projection dirty — incrementally, with
    // no summary rebuild involved.
    const [row] = await db
      .select({ status: workspaces.status, mergedAt: workspaces.mergedAt, summaryDirty: workspaceSummary.dirty })
      .from(workspaces)
      .leftJoin(workspaceSummary, eq(workspaceSummary.workspaceId, workspaces.id))
      .where(eq(workspaces.id, workspaceId));
    expect(row.status).toBe("closed");
    expect(row.mergedAt).toBeTruthy();
    expect(row.summaryDirty).toBe(true);

    // And the next summary read reflects the merge from ROWS alone: closed+merged main
    // (issue is now archived/Done), zero git spawns.
    gitExecCalls.length = 0;
    const summaryMap = await buildWorkspaceSummaryMap([issueId], "main", db, new Set([issueId]));
    await flush();
    const main = summaryMap.get(issueId)?.main;
    expect(main?.status).toBe("closed");
    expect(main?.mergedAt).toBeTruthy();
    expect(gitExecCalls).toEqual([]);
  });
});

describe("workspace-summary projection — heal pass (external drift)", () => {
  it("refreshes a dirty workspace (simulated external mutation) and clears the flag", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, {
      projection: { summaryDirty: true }, // external git mutation, board saw no event
    });

    const healed = await healWorkspaceSummaryProjection(db);
    expect(healed).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({
        summaryHeadSha: workspaceSummary.headSha,
        summaryCommitCount: workspaceSummary.commitCount,
        summaryDirty: workspaceSummary.dirty,
        summaryGitRefreshedAt: workspaceSummary.gitRefreshedAt,
      })
      .from(workspaceSummary).where(eq(workspaceSummary.workspaceId, workspaceId));
    expect(row.summaryHeadSha).toBe("abc999");
    expect(row.summaryCommitCount).toBe(5);
    expect(row.summaryDirty).toBe(false);
    expect(row.summaryGitRefreshedAt).toBeTruthy();
  });

  it("stamps a vanished-workingDir workspace with nulls so it stops being re-picked", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, {
      workingDir: join(tmpdir(), `ws-proj-gone-${randomUUID()}`),
      projection: { summaryDirty: true },
    });

    await healWorkspaceSummaryProjection(db);

    const [row] = await db
      .select({
        summaryHeadSha: workspaceSummary.headSha,
        summaryDirty: workspaceSummary.dirty,
        summaryGitRefreshedAt: workspaceSummary.gitRefreshedAt,
      })
      .from(workspaceSummary).where(eq(workspaceSummary.workspaceId, workspaceId));
    expect(row.summaryHeadSha).toBeNull();
    expect(row.summaryDirty).toBe(false);
    expect(row.summaryGitRefreshedAt).toBeTruthy();
    expect(gitExecCalls).toEqual([]); // no doomed spawns for a gone worktree

    // A second pass finds nothing to do within the TTL window.
    const healedAgain = await healWorkspaceSummaryProjection(db);
    expect(healedAgain).toBe(0);
  });

  it("bounds the batch per tick", async () => {
    const { db } = createTestDb();
    for (let i = 0; i < 4; i++) {
      await seed(db, { projection: { summaryDirty: true } });
    }
    const healed = await healWorkspaceSummaryProjection(db, { limit: 2 });
    expect(healed).toBe(2);
  });
});
