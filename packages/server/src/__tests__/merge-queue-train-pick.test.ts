import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, preferences, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { pickQueueStrategy } from "../services/merge-queue-train.js";
import type { MergeQueuePlan, WorkspaceQueueInfo } from "../services/merge-queue.service.js";

/**
 * #1180 — `pickQueueStrategy` is `executeQueue`'s train-vs-sequential decision, and a batch of
 * >= 2 that does NOT train now says why in one `[merge-queue]` line. `merge-queue-train-dispatch.test.ts`
 * drives the decision end to end with real git; this suite pins the DECISION and its log against a
 * synthetic plan, which is what makes the "why not" text testable without a repo.
 */
async function seedIssue(db: TestDb, repoPath = "/repo-a") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "P", repoPath, repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "Issue", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  return { projectId, issueId };
}

function member(id: string, issueId: string, overrides: Partial<WorkspaceQueueInfo> = {}): WorkspaceQueueInfo {
  return {
    id,
    branch: `feature/${id}`,
    workingDir: `/repo-a/.worktrees/${id}`,
    baseBranch: "main",
    repoPath: "/repo-a",
    issueId,
    issueNumber: 1,
    issueTitle: "Issue",
    changedFiles: [],
    status: "idle",
    isDirect: false,
    ...overrides,
  };
}

function plan(order: WorkspaceQueueInfo[], recommendedStrategy: MergeQueuePlan["recommendedStrategy"] = "direct"): MergeQueuePlan {
  return { order, overlaps: [], totalOverlapScore: 0, migrationCollisions: [], conflictPreviews: [], clusters: [], recommendedStrategy, strategyReason: "test" };
}

const logged = (log: ReturnType<typeof vi.spyOn>) =>
  log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[merge-queue] no train"));

describe("pickQueueStrategy (#1180)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an eligible batch with the caller asking for a train rides it, silently", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedIssue(db);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const strategy = await pickQueueStrategy(plan([member("a", issueId), member("b", issueId)]), { strategy: "train" }, db);
    expect(strategy).toBe("train");
    expect(logged(log)).toEqual([]);
  });

  it("names the missing opt-in — posture and trainMaxSize — when an eligible batch stays sequential", async () => {
    const { db } = createTestDb();
    const { projectId, issueId } = await seedIssue(db);
    invalidatePreferencesCache();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const strategy = await pickQueueStrategy(plan([member("a", issueId), member("b", issueId)]), {}, db);
    expect(strategy).toBe("sequential");
    expect(logged(log)).toEqual([
      `[merge-queue] no train for project ${projectId}: opt-in false (posture standard, trainMaxSize 1), 2 ride sequentially`,
    ]);
  });

  it("names the first ineligible member and its reason when the caller wanted a train but the shape refused", async () => {
    const { db } = createTestDb();
    const { projectId, issueId } = await seedIssue(db);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const order = [member("aaaaaaaa-1", issueId), member("bbbbbbbb-2", issueId, { branch: "" })];
    const strategy = await pickQueueStrategy(plan(order), { strategy: "train" }, db);
    expect(strategy).toBe("sequential");
    expect(logged(log)).toEqual([
      `[merge-queue] no train for project ${projectId}: 1 member(s) ineligible (first: ws bbbbbbbb #1 — no branch), 2 ride sequentially`,
    ]);
  });

  it("names the repo/base pairs when every member could ride but they do not share one train", async () => {
    const { db } = createTestDb();
    const { projectId, issueId } = await seedIssue(db);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const order = [member("a", issueId), member("b", issueId, { repoPath: "/repo-b" })];
    expect(await pickQueueStrategy(plan(order), { strategy: "train" }, db)).toBe("sequential");
    expect(logged(log)).toEqual([
      `[merge-queue] no train for project ${projectId}: members span 2 repo/base pair(s) (/repo-a@main, /repo-b@main), 2 ride sequentially`,
    ]);
  });

  it("an explicit sequential request and a lone member both stay quiet — there was no train to explain away", async () => {
    const { db } = createTestDb();
    const { issueId, projectId } = await seedIssue(db);
    await db.insert(preferences).values({ key: `train_max_size_${projectId}`, value: "4", updatedAt: new Date().toISOString() });
    invalidatePreferencesCache();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await pickQueueStrategy(plan([member("a", issueId), member("b", issueId)]), { strategy: "sequential" }, db)).toBe("sequential");
    expect(await pickQueueStrategy(plan([member("a", issueId)]), {}, db)).toBe("sequential");
    // And the opt-in itself still works: 2 eligible members + train_max_size 4 -> train.
    expect(await pickQueueStrategy(plan([member("a", issueId), member("b", issueId)]), {}, db)).toBe("train");
    expect(logged(log)).toEqual([]);
  });
});
