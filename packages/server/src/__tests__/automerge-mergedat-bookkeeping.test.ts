/**
 * #356 — `workspaces.mergedAt` was left NULL for merges that landed through `autoMerge`
 * (review-exit foundational merge, plugin-loop autoLand, fix-and-merge retry).
 *
 * Measured on a live pm-pipeline run: 2 of 4 workspaces were `closed` with `mergedAt: null`
 * while their merge commits sat on `master`. `doMerge` has stamped the record all along; this
 * path closed the row with `{ readyForMerge: false }` and nothing else. The consequences were
 * all silent: `listPluginLoopUnmergedWorkspaces` keys on `mergedAt IS NULL`, so a landed step
 * kept claiming the `awaitingMerge` banner (#353), and every cost rollup / merge-latency
 * measurement / ancestor invariant scanner reads the same column.
 *
 * `runMergeCore` is mocked here: the subject is the BOOKKEEPING around a successful merge, not
 * git. (The #350 checkout assertion inside the real core is covered by
 * merge-checkout-and-bookkeeping-invariants.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

vi.mock("../startup/done-unmerged-invariant-scanner.js", () => ({
  runDoneUnmergedScannerNow: vi.fn(),
}));

const { runMergeCore, cleanupMergedWorktreeAndBranch } = vi.hoisted(() => ({
  runMergeCore: vi.fn(),
  cleanupMergedWorktreeAndBranch: vi.fn(),
}));
vi.mock("../services/merge-executor.service.js", () => ({
  runMergeCore,
  cleanupMergedWorktreeAndBranch,
  getDirtyMainFiles: vi.fn(async () => []),
}));

import { db } from "../db/index.js";
import { createAutoMerge } from "../startup/merge-workflow.js";
import { gateSkipExplicit } from "../services/pre-merge-gate.service.js";
import { activeMerges } from "../services/workspace-internals.js";
import type { createBoardEvents } from "../services/board-events.js";
import type { createSessionManager } from "../services/session.manager.js";
import { makeTempRepo } from "./helpers/temp-repo.js";

const REPO_PATH = makeTempRepo();

async function seed() {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: REPO_PATH, repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 356, title: "mergedAt left null", priority: "high",
    sortOrder: 0, statusId: inReviewStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-356-test", workingDir: null, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: true, provider: "claude", createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId, doneStatusId };
}

beforeEach(() => {
  activeMerges.clear();
  runMergeCore.mockReset().mockResolvedValue({
    mergeOutput: "Merge made by the 'ort' strategy.",
    mergeCommitSha: "merge-commit-sha",
    preMergeHead: "pre-merge-head",
    mergedHeadSha: "feature-tip-sha",
    pendingWorkingTreeSyncSha: null,
  });
  cleanupMergedWorktreeAndBranch.mockReset().mockResolvedValue(undefined);
});

describe("#356: autoMerge records the merge on the workspace row", () => {
  it("stamps mergedAt, mergedHeadSha and closedAt, and does not backdate them to before the gate", async () => {
    const { projectId, issueId, workspaceId, doneStatusId } = await seed();
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

    // The `now` autoMerge receives is captured before the learning step and the pre-merge gate,
    // which measured 20-40 minutes on a live run. Backdating the merge record to it is why
    // `updatedAt` appeared untouched while the status demonstrably moved twice.
    const staleNow = new Date(Date.now() - 40 * 60 * 1000).toISOString();

    const autoMerge = createAutoMerge({
      sessionManager: { startSession: vi.fn(async () => "sess-1") } as unknown as ReturnType<typeof createSessionManager>,
      boardEvents: { broadcast: vi.fn() } as unknown as ReturnType<typeof createBoardEvents>,
      learningSessionIds: new Set(),
    });

    await autoMerge(ws, projectId, issueId, doneStatusId, staleNow,
      gateSkipExplicit("test: #356 bookkeeping — the gate decision is exercised elsewhere"));

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(row.status).toBe("closed");
    // The whole bug: this was null while the merge commit sat on master.
    expect(row.mergedAt).not.toBeNull();
    expect(row.mergedHeadSha).toBe("feature-tip-sha");
    expect(row.closedAt).not.toBeNull();
    expect(new Date(row.mergedAt as string).getTime()).toBeGreaterThan(new Date(staleNow).getTime());
    expect(new Date(row.updatedAt).getTime()).toBeGreaterThan(new Date(staleNow).getTime());
  });
});
