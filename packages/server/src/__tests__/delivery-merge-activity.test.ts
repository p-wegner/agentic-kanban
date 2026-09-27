import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issues, mergeTrains, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { getDeliveryStatus } from "../services/delivery-status.service.js";
import { getMergeActivity, MERGE_ACTIVITY_RECENT_WINDOW_MS } from "../services/merge-activity.service.js";

/**
 * The Delivery chip's live merge state: the running train with its members as tickets, the
 * last train finished within the window, and the ready branches NOT aboard the live train.
 */
type Db = ReturnType<typeof createTestDb>["db"];

const MIN = 60_000;

async function seed(db: Db, count: number) {
  const now = new Date(Date.now() - 30 * MIN).toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: join(tmpdir(), "kanban-no-such-repo-merge-activity"), repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "AI Reviewed", sortOrder: 0, isDefault: false, createdAt: now });
  const ws: string[] = [];
  for (let i = 0; i < count; i++) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(issues).values({
      id: issueId, issueNumber: 100 + i, title: `Ticket ${100 + i}`, priority: "medium", sortOrder: i,
      statusId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: `feature/${workspaceId}`, workingDir: `/tmp/wt/${workspaceId}`,
      baseBranch: "main", isDirect: false, status: "idle", readyForMerge: true, provider: "claude",
      // Staggered so the waiting list's oldest-first order is observable.
      createdAt: now, updatedAt: new Date(Date.now() - (30 - i) * MIN).toISOString(),
    });
    ws.push(workspaceId);
  }
  return { projectId, ws };
}

async function train(db: Db, projectId: string, row: Partial<typeof mergeTrains.$inferInsert> & { label: string; members: string[] }) {
  const { members, ...rest } = row;
  await db.insert(mergeTrains).values({
    id: randomUUID(), projectId, memberWorkspaceIds: JSON.stringify(members), state: "gating",
    startedAt: new Date(Date.now() - 12 * MIN).toISOString(), ...rest,
  });
}

describe("mergeActivity on the delivery read model", () => {
  it("names the live train's members as tickets and lists only the ready branches not aboard", async () => {
    const { db } = createTestDb();
    const { projectId, ws } = await seed(db, 5);
    await train(db, projectId, { label: "train/2026-09-27-05", members: [ws[2], ws[0]] });

    const status = await getDeliveryStatus(projectId, db);
    const activity = status.mergeActivity!;
    expect(activity.current).toMatchObject({ label: "train/2026-09-27-05", state: "gating", bisecting: false, finishedAt: null, landedCount: null });
    expect(activity.current!.members.map((m) => [m.issueNumber, m.title])).toEqual([[102, "Ticket 102"], [100, "Ticket 100"]]);
    expect(activity.waiting.map((w) => w.issueNumber)).toEqual([101, 103, 104]);
    // queueDepth counts every ready branch, train members included — the same rows, read once.
    expect(status.queuePressure?.queueDepth).toBe(5);
    expect(activity.lastFinished).toBeNull();
  });

  it("a gating train with a red attempt in its evidence is bisecting", async () => {
    const { db } = createTestDb();
    const { projectId, ws } = await seed(db, 2);
    await train(db, projectId, {
      label: "train/2026-09-27-06", members: ws,
      gateEvidence: JSON.stringify({ attempts: [{ label: "train/2026-09-27-06", verdict: "red", failureHead: "suite x failed" }] }),
    });
    const activity = await getMergeActivity(projectId, [], db);
    expect(activity.current?.bisecting).toBe(true);
    expect(activity.current?.failureSummary).toBeNull();
  });

  it("reports the most recent finished train inside the window, with landed count or the red failure line", async () => {
    const { db } = createTestDb();
    const { projectId, ws } = await seed(db, 3);
    const nowMs = Date.now();
    await train(db, projectId, {
      label: "train/2026-09-27-03", members: [ws[0]], state: "landed",
      startedAt: new Date(nowMs - 90 * MIN).toISOString(), finishedAt: new Date(nowMs - 80 * MIN).toISOString(),
      gateEvidence: JSON.stringify({ landed: [ws[0]], landedCount: 1 }),
    });
    await train(db, projectId, {
      label: "train/2026-09-27-04", members: [ws[1], ws[2]], state: "red",
      startedAt: new Date(nowMs - 20 * MIN).toISOString(), finishedAt: new Date(nowMs - 5 * MIN).toISOString(),
      gateEvidence: JSON.stringify({ gateFailure: "\nfailing suite(s): a.test.ts [deterministic guard failure]\nmore", landed: [] }),
    });

    const activity = await getMergeActivity(projectId, [], db, nowMs);
    expect(activity.current).toBeNull();
    expect(activity.lastFinished).toMatchObject({
      label: "train/2026-09-27-04", state: "red", landedCount: 0,
      failureSummary: "failing suite(s): a.test.ts [deterministic guard failure]",
    });
    expect(activity.lastFinished!.members.map((m) => m.issueNumber)).toEqual([101, 102]);
  });

  it("drops a finished train older than the window, and an abandoned one falls back to the reconciler's reason", async () => {
    const { db } = createTestDb();
    const { projectId, ws } = await seed(db, 1);
    const nowMs = Date.now();
    await train(db, projectId, {
      label: "old", members: ws, state: "landed",
      startedAt: new Date(nowMs - MERGE_ACTIVITY_RECENT_WINDOW_MS - 20 * MIN).toISOString(),
      finishedAt: new Date(nowMs - MERGE_ACTIVITY_RECENT_WINDOW_MS - 10 * MIN).toISOString(),
    });
    expect((await getMergeActivity(projectId, [], db, nowMs)).lastFinished).toBeNull();

    await train(db, projectId, {
      label: "train/2026-09-27-07", members: ws, state: "abandoned", reconciledReason: "stranded by a restart",
      startedAt: new Date(nowMs - 10 * MIN).toISOString(), finishedAt: new Date(nowMs - 2 * MIN).toISOString(),
    });
    expect((await getMergeActivity(projectId, [], db, nowMs)).lastFinished).toMatchObject({
      label: "train/2026-09-27-07", state: "abandoned", failureSummary: "stranded by a restart", landedCount: null,
    });
  });

  it("a member whose workspace is gone keeps its id with a null ticket", async () => {
    const { db } = createTestDb();
    const { projectId } = await seed(db, 0);
    await train(db, projectId, { label: "q1", members: ["ghost-ws"] });
    const activity = await getMergeActivity(projectId, [], db);
    expect(activity.current?.members).toEqual([{ workspaceId: "ghost-ws", issueNumber: null, title: null }]);
  });
});
