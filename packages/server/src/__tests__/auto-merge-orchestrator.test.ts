import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces, preferences, sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/repo",
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [idx, name] of ["In Review", "AI Reviewed", "Done"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder: idx,
      isDefault: false,
      createdAt: now,
    });
  }
  return { projectId, statusIds };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    projectId: string;
    statusId: string;
    readyForMerge?: boolean;
    workspaceStatus?: string;
    isDirect?: boolean;
  },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Issue",
    priority: "medium",
    sortOrder: 0,
    statusId: opts.statusId,
    projectId: opts.projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: `feature/${workspaceId}`,
    workingDir: `/tmp/repo/.worktrees/${workspaceId}`,
    baseBranch: "main",
    isDirect: opts.isDirect ?? false,
    status: opts.workspaceStatus ?? "idle",
    readyForMerge: opts.readyForMerge ?? false,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

describe("auto-merge orchestrator", () => {
  it("runs only when the merge strategy is the merge queue", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    await db.insert(preferences).values([
      { key: "auto_merge", value: "true", updatedAt: now },
      { key: "auto_monitor", value: "true", updatedAt: now },
      { key: "merge_strategy", value: "merge_queue", updatedAt: now },
    ]);

    const queueOrchestrator = createAutoMergeOrchestrator({ database: db });
    await queueOrchestrator.runOnce();
    expect(queueOrchestrator.state.lastRunAt).not.toBeNull();

    await db.update(preferences).set({ value: "monitor", updatedAt: now }).where(eq(preferences.key, "merge_strategy"));
    const monitorOrchestrator = createAutoMergeOrchestrator({ database: db });
    await monitorOrchestrator.runOnce();
    expect(monitorOrchestrator.state.lastRunAt).toBeNull();
  });

  it("finds idle reviewed workspaces (incl. ready work stranded in Done) and excludes direct, closed, in-progress, and user-parked Done", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const ready = await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: true });
    const aiReviewed = await seedWorkspace(db, { projectId, statusId: statusIds["AI Reviewed"] });
    await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: true, isDirect: true }); // excluded: direct
    await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: true, workspaceStatus: "closed" }); // excluded: closed
    await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: false }); // excluded: not ready / not auto-in-review
    // #534: a readyForMerge workspace whose issue was moved to terminal Done before the
    // merge tick is stranded-but-recoverable (readyForMerge ⇒ review-approved, not a user park).
    const doneReady = await seedWorkspace(db, { projectId, statusId: statusIds["Done"], readyForMerge: true });
    // A user-parked Done workspace (NOT ready) stays excluded — don't auto-merge it.
    await seedWorkspace(db, { projectId, statusId: statusIds["Done"], readyForMerge: false });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const ids = await orchestrator.findCompletedWorkspaceIds();
    expect(ids).toEqual(expect.arrayContaining([ready, aiReviewed, doneReady]));
    expect(ids).toHaveLength(3);
  });

  it("excludes a project that has auto_merge_disabled_<projectId> set", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const { projectId, statusIds } = await seedProject(db);
    const ready = await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: true });
    await db.insert(preferences).values({ key: `auto_merge_disabled_${projectId}`, value: "true", updatedAt: now });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    await expect(orchestrator.findCompletedWorkspaceIds()).resolves.not.toContain(ready);
    await expect(orchestrator.findCompletedWorkspaceIds()).resolves.toHaveLength(0);
  });

  it("includes idle In Review workspaces only when auto_merge_in_review is enabled", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const inReview = await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: false });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    await expect(orchestrator.findCompletedWorkspaceIds()).resolves.not.toContain(inReview);

    await db.insert(preferences).values({
      key: "auto_merge_in_review",
      value: "true",
      updatedAt: new Date().toISOString(),
    });

    await expect(orchestrator.findCompletedWorkspaceIds()).resolves.toContain(inReview);
  });

  it("reaps a zombie reconciler session (running >5m with 0 output) so the next tick can relaunch", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    await db.insert(preferences).values([
      { key: "auto_merge", value: "true", updatedAt: now },
      { key: "merge_strategy", value: "merge_queue", updatedAt: now },
    ]);

    const { projectId, statusIds } = await seedProject(db);
    const workspaceId = await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], workspaceStatus: "fixing" });

    // Plant a "running" session started 6 minutes ago with no output messages → zombie
    const sessionId = randomUUID();
    const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      status: "running",
      startedAt: sixMinAgo,
    });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    // Inject the zombie into state as if it were launched on a prior tick.
    orchestrator.state.reconciler = {
      sessionId,
      integrationWorkspaceId: workspaceId,
      baseBranch: "main",
      strandedKey: "fake-key",
      launchedAt: sixMinAgo,
    };

    // runOnce should detect the zombie, reap it (state.reconciler = null), and free the workspace.
    await orchestrator.runOnce(true /* force — skip isEnabled() */);

    expect(orchestrator.state.reconciler).toBeNull();
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws?.status).toBe("idle");
  });
});
