// @covers workspaces.multiRepo.mergeStatusProjection [perf,state-transition]
/**
 * #415 — the per-repo merge-status projection (repos.summary_*, migration 0118),
 * extending #399 / decision 014 to sibling AND leading repos rows.
 *
 * Tested at the git-exec SEAM (like workspace-summary-projection.test.ts) so ANY git
 * subprocess is caught:
 *   1. Projection-fresh rows answer getRepoMergeStatus with ZERO git spawns.
 *   2. A dirty row falls back to LIVE git — correct facts — and writes through, so the
 *      NEXT read is spawn-free.
 *   3. setWorkspaceStatus (the single status authority) dirties the repos rows.
 *   4. The bounded heal pass refreshes dirty per-repo projections.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, repos, workspaceSummary } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";

// ─── git-exec seam spy ──────────────────────────────────────────────────────
const gitExecCalls: string[][] = [];
function canned(args: string[]): string {
  if (args[0] === "rev-parse") return "livesha";
  if (args[0] === "rev-list") return "2";
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
    return { stdout: canned(args), stderr: "", code: 0 };
  }),
  gitExecOrThrow: vi.fn(async (args: string[]) => {
    gitExecCalls.push(args);
    return canned(args);
  }),
  gitExecSync: vi.fn((args: string[]) => {
    gitExecCalls.push(args);
    return canned(args);
  }),
  gitStream: vi.fn(() => {
    throw new Error("gitStream not expected in these tests");
  }),
}));

import * as realGitService from "../services/git.service.js";
import { getRepoMergeStatus } from "../services/repo-merge-status.service.js";
import { healWorkspaceSummaryProjection } from "../services/workspace-summary-projection.service.js";
import type { GitService } from "../services/workspace-internals.js";

function tempRepoDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak-rms-proj-${label}-`));
  writeFileSync(join(dir, ".git"), "gitdir: /nowhere\n", "utf-8");
  return dir;
}

let db: TestDb;
let projectId: string;
let workspaceId: string;
let leadRepoPath: string;
let sibRepoPath: string;
let sibRowId: string;

interface ProjSeed {
  summaryAhead?: number | null;
  summaryHistoric?: number | null;
  summaryGitRefreshedAt?: string | null;
  summaryDirty?: boolean;
}

async function seed(leadProj: ProjSeed, sibProj: ProjSeed) {
  ({ db } = createTestDb());
  const now = new Date().toISOString();
  projectId = randomUUID();
  leadRepoPath = tempRepoDir("lead");
  sibRepoPath = tempRepoDir("sib");
  await db.insert(projects).values({
    id: projectId, name: "Proj", repoPath: leadRepoPath, repoName: "lead",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "t", statusId, projectId, createdAt: now, updatedAt: now });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: join(leadRepoPath, ".worktrees", "ak-1"),
    baseBranch: "main", isDirect: false, status: "idle",
    createdAt: now, updatedAt: now,
  });
  // Keep the WORKSPACE summary projection fresh so its SWR machinery never spawns here.
  // #815: it lives in `workspace_summary` now, not in five columns above — and it has to be
  // written explicitly, because an ABSENT row reads as DIRTY, not as clean.
  await db.insert(workspaceSummary).values({
    workspaceId, headSha: "abc", headMessage: "m", commitCount: 1,
    gitRefreshedAt: now, dirty: false,
  });
  await db.insert(repos).values({
    id: `leading-${workspaceId}`, workspaceId, path: leadRepoPath, name: null,
    worktreePath: join(leadRepoPath, ".worktrees", "ak-1"), branch: "feature/ak-1",
    baseBranch: "main", baseCommitSha: "cutsha", isLeading: true, createdAt: now,
    summaryAhead: leadProj.summaryAhead ?? null,
    summaryHistoric: leadProj.summaryHistoric ?? null,
    summaryGitRefreshedAt: leadProj.summaryGitRefreshedAt ?? null,
    summaryDirty: leadProj.summaryDirty ?? true,
  });
  sibRowId = randomUUID();
  await db.insert(repos).values({
    id: sibRowId, workspaceId, projectId, path: sibRepoPath, name: "sib",
    worktreePath: join(sibRepoPath, ".worktrees", "ak-1"), branch: "feature/ak-1",
    baseBranch: "main", baseCommitSha: "cutsha", isLeading: false, createdAt: now,
    summaryAhead: sibProj.summaryAhead ?? null,
    summaryHistoric: sibProj.summaryHistoric ?? null,
    summaryGitRefreshedAt: sibProj.summaryGitRefreshedAt ?? null,
    summaryDirty: sibProj.summaryDirty ?? true,
  });
}

beforeEach(() => {
  gitExecCalls.length = 0;
});

const deps = () => ({ database: db as unknown as Database, gitService: realGitService as GitService });

describe("repo-merge-status projection (#415)", () => {
  it("answers from FRESH projections with ZERO git spawns (leading + sibling)", async () => {
    const now = new Date().toISOString();
    await seed(
      { summaryAhead: 3, summaryHistoric: 0, summaryGitRefreshedAt: now, summaryDirty: false },
      { summaryAhead: 0, summaryHistoric: 2, summaryGitRefreshedAt: now, summaryDirty: false },
    );

    const status = await getRepoMergeStatus(workspaceId, deps());

    expect(status.repos).toHaveLength(2);
    // Leading: 3 ahead → stranded work.
    expect(status.repos[0]).toMatchObject({ isLeading: true, hasWork: true, ahead: 3, merged: false, stranded: true });
    // Sibling: 0 ahead but historic work → landed.
    expect(status.repos[1]).toMatchObject({ name: "sib", hasWork: true, ahead: 0, merged: true, stranded: false });
    expect(status.allMerged).toBe(false);
    expect(gitExecCalls).toEqual([]); // the acceptance criterion
  });

  it("falls back to LIVE git for dirty rows, writes through, and the next read is spawn-free", async () => {
    await seed({ summaryDirty: true }, { summaryDirty: true });

    const status = await getRepoMergeStatus(workspaceId, deps());

    // Live facts from the canned seam: rev-list --count → 2 ahead in both repos.
    expect(status.repos[0]).toMatchObject({ hasWork: true, ahead: 2, stranded: true });
    expect(status.repos[1]).toMatchObject({ hasWork: true, ahead: 2, stranded: true });
    expect(gitExecCalls.length).toBeGreaterThan(0);

    // Write-through landed: facts persisted, dirty cleared, freshness stamped.
    const rows = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
    for (const row of rows) {
      expect(row.summaryAhead).toBe(2);
      expect(row.summaryHistoric).toBe(0);
      expect(row.summaryDirty).toBe(false);
      expect(row.summaryGitRefreshedAt).toBeTruthy();
    }

    // Second read within TTL: identical answer, zero spawns.
    gitExecCalls.length = 0;
    const again = await getRepoMergeStatus(workspaceId, deps());
    expect(again).toEqual(status);
    expect(gitExecCalls).toEqual([]);
  });

  it("a stamped mergedHeadSha still short-circuits to merged without reading the projection", async () => {
    await seed({ summaryDirty: true }, { summaryDirty: true });
    await db.update(repos).set({ mergedHeadSha: "deadbeef" }).where(eq(repos.workspaceId, workspaceId));

    const status = await getRepoMergeStatus(workspaceId, deps());
    expect(status.repos.every((r) => r.merged)).toBe(true);
    expect(status.allMerged).toBe(true);
    expect(gitExecCalls).toEqual([]);
  });
});

describe("repo projection — board events mark dirty (#415)", () => {
  it("setWorkspaceStatus dirties the workspace's repos rows atomically", async () => {
    const now = new Date().toISOString();
    await seed(
      { summaryAhead: 1, summaryGitRefreshedAt: now, summaryDirty: false },
      { summaryAhead: 1, summaryGitRefreshedAt: now, summaryDirty: false },
    );

    const ok = await setWorkspaceStatus(db, workspaceId, "reviewing", { caller: "test" });
    expect(ok).toBe(true);

    const rows = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.summaryDirty).toBe(true);
  });
});

describe("repo projection — heal pass (#415)", () => {
  it("refreshes dirty per-repo projections on the shared bounded tick", async () => {
    await seed({ summaryDirty: true }, { summaryDirty: true });

    const healed = await healWorkspaceSummaryProjection(db as unknown as Database);
    expect(healed).toBeGreaterThanOrEqual(2);

    const rows = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
    for (const row of rows) {
      expect(row.summaryAhead).toBe(2); // canned rev-list count
      expect(row.summaryDirty).toBe(false);
      expect(row.summaryGitRefreshedAt).toBeTruthy();
    }

    // A projection-fresh read right after the heal is spawn-free.
    gitExecCalls.length = 0;
    const status = await getRepoMergeStatus(workspaceId, deps());
    expect(status.repos[1]).toMatchObject({ ahead: 2, stranded: true });
    expect(gitExecCalls).toEqual([]);
  });

  it("stamps a vanished repo root as no-work instead of spawning doomed git", async () => {
    await seed({ summaryDirty: true }, { summaryDirty: true });
    // Point the sibling row at a nonexistent path.
    const gonePath = join(tmpdir(), `rms-proj-gone-${randomUUID()}`);
    await db.update(repos).set({ path: gonePath }).where(eq(repos.id, sibRowId));

    await healWorkspaceSummaryProjection(db as unknown as Database);

    const [row] = await db.select().from(repos).where(eq(repos.id, sibRowId));
    expect(row.summaryAhead).toBe(0);
    expect(row.summaryHistoric).toBe(0);
    expect(row.summaryDirty).toBe(false);
  });
});
