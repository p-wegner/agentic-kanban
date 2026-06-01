import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueDependencies, issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { buildDependencyWavePlan, startNextDependencyWave } from "../services/dependency-wave.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Wave Project",
    repoPath: "/tmp/wave-project",
    repoName: "wave-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [index, name] of ["Backlog", "Todo", "In Progress", "Done", "Cancelled"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder: index,
      isDefault: name === "Todo",
      createdAt: now,
    });
  }

  return { projectId, statusIds };
}

async function insertIssue(db: TestDb, input: {
  projectId: string;
  statusId: string;
  title: string;
  issueNumber: number;
  sortOrder?: number;
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: input.issueNumber,
    title: input.title,
    priority: "medium",
    issueType: "task",
    sortOrder: input.sortOrder ?? input.issueNumber,
    statusId: input.statusId,
    projectId: input.projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function insertDependency(db: TestDb, issueId: string, dependsOnId: string) {
  await db.insert(issueDependencies).values({
    id: randomUUID(),
    issueId,
    dependsOnId,
    type: "depends_on",
    createdAt: new Date().toISOString(),
  });
}

describe("dependency wave planner", () => {
  it("groups ready and blocked issues and reports specific upstream blockers", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const done = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Merged foundation", issueNumber: 1 });
    const blocker = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Open API", issueNumber: 2 });
    const ready = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Ready UI", issueNumber: 3 });
    const unblockedByDone = await insertIssue(db, { projectId, statusId: statusIds.Backlog, title: "Uses foundation", issueNumber: 4 });
    const blocked = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Needs API", issueNumber: 5 });

    await insertDependency(db, unblockedByDone, done);
    await insertDependency(db, blocked, blocker);

    const plan = await buildDependencyWavePlan(db, projectId, { wipLimit: 5 });

    expect(plan.readyNow.map((issue) => issue.id)).toEqual(expect.arrayContaining([ready, unblockedByDone]));
    const blockedIssue = plan.blocked.find((issue) => issue.id === blocked);
    expect(blockedIssue?.blockers).toEqual([
      expect.objectContaining({ issueId: blocker, issueNumber: 2, title: "Open API" }),
    ]);
    expect(plan.cyclicInvalid).toEqual([]);
  });

  it("places cycle participants in cyclicInvalid instead of ready or blocked", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const a = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Cycle A", issueNumber: 1 });
    const b = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Cycle B", issueNumber: 2 });
    await insertDependency(db, a, b);
    await insertDependency(db, b, a);

    const plan = await buildDependencyWavePlan(db, projectId, { wipLimit: 5 });

    expect(plan.cyclicInvalid.map((issue) => issue.id).sort()).toEqual([a, b].sort());
    expect(plan.readyNow.map((issue) => issue.id)).not.toContain(a);
    expect(plan.blocked.map((issue) => issue.id)).not.toContain(b);
  });

  it("starts only the next ready wave that fits under the WIP limit", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    await db.insert(preferences).values({ key: "nudge_wip_limit", value: "2" });
    const active = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Active work", issueNumber: 1 });
    const readyOne = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Ready one", issueNumber: 2 });
    const readyTwo = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Ready two", issueNumber: 3 });
    await db.insert(workspaces).values({
      id: randomUUID(),
      issueId: active,
      branch: "feature/ak-1-active",
      workingDir: "/tmp/wave-project/.worktrees/active",
      baseBranch: "main",
      isDirect: false,
      status: "active",
      provider: "claude",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const createWorkspace = vi.fn(async (issue: { id: string }) => ({ id: `ws-${issue.id}` }));

    const result = await startNextDependencyWave(db, projectId, { createWorkspace });

    expect(result.started).toHaveLength(1);
    expect(result.skipped.readyButNotStarted).toBe(1);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect([readyOne, readyTwo]).toContain(createWorkspace.mock.calls[0][0].id);
  });
});
