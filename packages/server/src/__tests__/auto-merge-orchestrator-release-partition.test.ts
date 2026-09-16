import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";

/**
 * #1180 — `runOnce` partitions a cross-repo release before the queue asks `trainEligible`.
 *
 * Measured 2026-09-16 on the live board: every project window that closed on one tick was
 * released into ONE `executeQueue` call, so 13 workspaces over four repos reached
 * `trainEligible` as a single plan, failed it, and merged one by one with no `merge_trains` row
 * and nothing logged about why. The queue is mocked here: what this suite pins is the SHAPE of
 * the calls the orchestrator makes (one `train` call per repo, the branch-less member peeled off
 * into a `sequential` call) and the one log line that explains the split.
 */
const queueCalls = vi.hoisted(() => [] as { workspaceIds: string[]; strategy?: string }[]);
/** workspaceId -> queue-info overrides the mocked `computePlan` applies (repoPath, branch). */
const planShape = vi.hoisted(() => new Map<string, { repoPath: string; branch: string }>());

vi.mock("../services/merge-queue.service.js", () => ({
  createMergeQueueService: () => ({
    computePlan: async (workspaceIds: string[]) => ({
      order: workspaceIds.map((id) => {
        const shape = planShape.get(id)!;
        return {
          id,
          branch: shape.branch,
          workingDir: `${shape.repoPath}/.worktrees/${id}`,
          baseBranch: "main",
          repoPath: shape.repoPath,
          issueId: `issue-${id}`,
          issueNumber: null,
          issueTitle: "Issue",
          changedFiles: [],
          status: "idle",
          isDirect: false,
        };
      }),
      overlaps: [],
      totalOverlapScore: 0,
      migrationCollisions: [],
      conflictPreviews: [],
      clusters: [],
      recommendedStrategy: "direct",
      strategyReason: "test",
    }),
    executeQueue: async function* (workspaceIds: string[], opts: { strategy?: string } = {}) {
      queueCalls.push({ workspaceIds, strategy: opts.strategy });
      for (const id of workspaceIds) yield { type: "merged", workspaceId: id, issueNumber: null, issueTitle: "Issue" };
      yield { type: "done", merged: workspaceIds, failed: [], skipped: [] };
    },
  }),
}));

// Imported AFTER the mock so the orchestrator picks up the fake queue.
const { createAutoMergeOrchestrator } = await import("../startup/auto-merge-orchestrator.js");

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db, repoPath: string, windowSize = 2) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: repoPath, repoPath, repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "AI Reviewed", sortOrder: 0, isDefault: false, createdAt: now });
  // Window sized to the seeded members so the project releases on the very first tick.
  await db.insert(preferences).values({ key: `train_max_size_${projectId}`, value: String(windowSize), updatedAt: now });
  return { projectId, statusId, repoPath };
}

let nextIssueNumber = 1;

async function seedReadyWorkspace(db: Db, project: { projectId: string; statusId: string; repoPath: string }, branch?: string) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({ id: issueId, issueNumber: nextIssueNumber++, title: "Issue", priority: "medium", sortOrder: 0, statusId: project.statusId, projectId: project.projectId, createdAt: now, updatedAt: now });
  const resolvedBranch = branch ?? `feature/${workspaceId}`;
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: resolvedBranch,
    workingDir: `${project.repoPath}/.worktrees/${workspaceId}`,
    baseBranch: "main",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  planShape.set(workspaceId, { repoPath: project.repoPath, branch: resolvedBranch });
  return workspaceId;
}

describe("auto-merge orchestrator partitions a cross-repo release (#1180)", () => {
  afterEach(() => {
    queueCalls.length = 0;
    planShape.clear();
    vi.restoreAllMocks();
  });

  it("two projects closing their windows on one tick get one train call EACH, not one union call", async () => {
    const { db } = createTestDb();
    const a = await seedProject(db, "/repo-a");
    const b = await seedProject(db, "/repo-b");
    invalidatePreferencesCache();
    const a1 = await seedReadyWorkspace(db, a);
    const a2 = await seedReadyWorkspace(db, a);
    const b1 = await seedReadyWorkspace(db, b);
    const b2 = await seedReadyWorkspace(db, b);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    await orchestrator.runOnce(true);

    expect(queueCalls).toHaveLength(2);
    expect(queueCalls.map((c) => c.strategy)).toEqual(["train", "train"]);
    const byRepo = new Map(queueCalls.map((c) => [planShape.get(c.workspaceIds[0])!.repoPath, [...c.workspaceIds].sort()]));
    expect(byRepo.get("/repo-a")).toEqual([a1, a2].sort());
    expect(byRepo.get("/repo-b")).toEqual([b1, b2].sort());
    expect(orchestrator.state.lastMerged).toBe(4);

    const split = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("is not one train"));
    expect(split).toBe(
      "[auto-merge] release of 4 workspace(s) is not one train: 2 train(s) [/repo-a@main ×2, /repo-b@main ×2]",
    );
  });

  it("a branch-less member rides sequentially while the rest of its repo still forms a train", async () => {
    const { db } = createTestDb();
    const a = await seedProject(db, "/repo-a", 3);
    invalidatePreferencesCache();
    const a1 = await seedReadyWorkspace(db, a);
    const a2 = await seedReadyWorkspace(db, a);
    const orphan = await seedReadyWorkspace(db, a, "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    await orchestrator.runOnce(true);

    expect(queueCalls).toEqual([
      { workspaceIds: expect.arrayContaining([a1, a2]), strategy: "train" },
      { workspaceIds: [orphan], strategy: "sequential" },
    ]);
    expect(queueCalls[0].workspaceIds).toHaveLength(2);

    const split = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("is not one train"));
    expect(split).toBe(
      `[auto-merge] release of 3 workspace(s) is not one train: 1 train(s) [/repo-a@main ×2]; ` +
        `1 ride sequentially: 1 member(s) ineligible (first: ws ${orphan.slice(0, 8)} — no branch)`,
    );
  });

  it("a single-repo eligible batch is unchanged: exactly one train call and no split line", async () => {
    const { db } = createTestDb();
    const a = await seedProject(db, "/repo-a");
    invalidatePreferencesCache();
    const a1 = await seedReadyWorkspace(db, a);
    const a2 = await seedReadyWorkspace(db, a);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    await orchestrator.runOnce(true);

    expect(queueCalls).toEqual([{ workspaceIds: expect.arrayContaining([a1, a2]), strategy: "train" }]);
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes("is not one train"))).toBe(false);
  });
});
