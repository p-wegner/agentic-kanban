import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

const mocks = vi.hoisted(() => ({
  changedFilesByDir: new Map<string, string[]>(),
  mergeWorkspace: vi.fn(),
  rebaseOntoBase: vi.fn(),
  revParse: vi.fn(),
  isAncestor: vi.fn(),
  autoRenumberMigrations: vi.fn(),
}));

vi.mock("../services/git.service.js", () => ({
  getChangedFileNames: vi.fn((workingDir: string) => Promise.resolve(mocks.changedFilesByDir.get(workingDir) ?? [])),
  getChangedFilesBetween: vi.fn(() => Promise.resolve([])),
  rebaseOntoBase: mocks.rebaseOntoBase,
  revParse: mocks.revParse,
  isAncestor: mocks.isAncestor,
  autoRenumberMigrations: mocks.autoRenumberMigrations,
}));

vi.mock("../services/workspace-merge.service.js", () => ({
  createWorkspaceMergeService: () => ({
    mergeWorkspace: mocks.mergeWorkspace,
  }),
}));

import { createMergeQueueService } from "../services/merge-queue.service.js";

async function seedWorkspace(
  db: TestDb,
  opts: {
    projectId: string;
    statusId: string;
    issueNumber: number;
    issueTitle: string;
    workspaceId?: string;
    workingDir: string;
    branch: string;
  },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = opts.workspaceId ?? randomUUID();

  await db.insert(issues).values({
    id: issueId,
    issueNumber: opts.issueNumber,
    title: opts.issueTitle,
    priority: "medium",
    sortOrder: opts.issueNumber,
    statusId: opts.statusId,
    projectId: opts.projectId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: opts.branch,
    workingDir: opts.workingDir,
    baseBranch: "main",
    status: "idle",
    isDirect: false,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { issueId, workspaceId };
}

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Review",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  return { projectId, statusId };
}

describe("merge queue service", () => {
  beforeEach(() => {
    mocks.changedFilesByDir.clear();
    mocks.mergeWorkspace.mockReset();
    mocks.rebaseOntoBase.mockReset().mockResolvedValue({ success: true });
    mocks.revParse.mockReset().mockResolvedValue("feature-sha");
    mocks.isAncestor.mockReset().mockResolvedValue(true);
    mocks.autoRenumberMigrations.mockReset().mockResolvedValue({ renumbered: false, renames: [] });
  });

  it("reports migration-number collisions across queued workspaces", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const a = await seedWorkspace(db, {
      projectId,
      statusId,
      issueNumber: 11,
      issueTitle: "First migration",
      workingDir: "/repo/.worktrees/a",
      branch: "feature/a",
    });
    const b = await seedWorkspace(db, {
      projectId,
      statusId,
      issueNumber: 12,
      issueTitle: "Second migration",
      workingDir: "/repo/.worktrees/b",
      branch: "feature/b",
    });

    mocks.changedFilesByDir.set("/repo/.worktrees/a", [
      "packages/shared/drizzle/0062_first.sql",
      "packages/shared/drizzle/meta/_journal.json",
    ]);
    mocks.changedFilesByDir.set("/repo/.worktrees/b", [
      "packages/shared/drizzle/0062_second.sql",
      "packages/shared/drizzle/meta/_journal.json",
    ]);

    const service = createMergeQueueService({ database: db });
    const plan = await service.computePlan([a.workspaceId, b.workspaceId]);

    expect(plan.migrationCollisions).toEqual([
      {
        migrationNumber: "0062",
        workspaces: expect.arrayContaining([
          expect.objectContaining({ workspaceId: a.workspaceId, issueNumber: 11, files: ["packages/shared/drizzle/0062_first.sql"] }),
          expect.objectContaining({ workspaceId: b.workspaceId, issueNumber: 12, files: ["packages/shared/drizzle/0062_second.sql"] }),
        ]),
      },
    ]);
  });

  it("emits an error when merge returns but the feature commit is not on the target branch", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const { workspaceId } = await seedWorkspace(db, {
      projectId,
      statusId,
      issueNumber: 21,
      issueTitle: "Verify merge",
      workingDir: "/repo/.worktrees/verify",
      branch: "feature/verify",
    });

    mocks.mergeWorkspace.mockImplementation(async (id: string) => {
      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "closed", mergedAt: now, updatedAt: now }).where(eq(workspaces.id, id));
      return { id, mergeOutput: "ok" };
    });
    mocks.isAncestor.mockResolvedValue(false);

    const service = createMergeQueueService({ database: db });
    const events = [];
    for await (const event of service.executeQueue([workspaceId])) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      workspaceId,
      error: expect.stringContaining("not reachable from main"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      merged: [],
      failed: [workspaceId],
    }));
  });

  it("renumbers migrations before the queue rebases the workspace", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const { workspaceId } = await seedWorkspace(db, {
      projectId,
      statusId,
      issueNumber: 31,
      issueTitle: "Queued migration",
      workingDir: "/repo/.worktrees/migration",
      branch: "feature/migration",
    });

    mocks.autoRenumberMigrations.mockResolvedValue({
      renumbered: true,
      renames: [{ from: "0062_conflict.sql", to: "0063_conflict.sql" }],
    });
    mocks.mergeWorkspace.mockImplementation(async (id: string) => {
      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "closed", mergedAt: now, updatedAt: now }).where(eq(workspaces.id, id));
      return { id, mergeOutput: "ok" };
    });

    const service = createMergeQueueService({ database: db });
    for await (const _event of service.executeQueue([workspaceId])) {
      // drain queue
    }

    expect(mocks.autoRenumberMigrations).toHaveBeenCalledWith("/repo/.worktrees/migration", "/repo", "main");
    expect(mocks.autoRenumberMigrations.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rebaseOntoBase.mock.invocationCallOrder[0],
    );
  });
});
