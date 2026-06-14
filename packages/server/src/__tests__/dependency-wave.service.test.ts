import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issueDependencies, issues, preferences, projectStatuses, projects, workflowNodes, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
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

async function insertWorkspace(db: TestDb, input: {
  issueId: string;
  branch: string;
  mergedAt?: string | null;
  isDirect?: boolean;
  status?: string;
}) {
  const now = new Date().toISOString();
  await db.insert(workspaces).values({
    id: randomUUID(),
    issueId: input.issueId,
    branch: input.branch,
    workingDir: `/tmp/wave-project/.worktrees/${input.branch}`,
    baseBranch: "main",
    isDirect: input.isDirect ?? false,
    status: input.status ?? "closed",
    provider: "claude",
    mergedAt: input.mergedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
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

  // Regression for #537: a workflow-driven Done blocker (currentNodeId != null,
  // nodeType !== "end") must still resolve so its dependents land in readyNow.
  it("treats a workflow-driven Done-STATUS blocker as resolved even when node is non-end (#537)", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const now = new Date().toISOString();

    // Insert a minimal workflow template + a non-`end` node to simulate the desync.
    const templateId = randomUUID();
    await db.insert(workflowTemplates).values({
      id: templateId,
      name: "Test Template",
      isDefault: false,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    const stuckNodeId = randomUUID();
    await db.insert(workflowNodes).values({
      id: stuckNodeId,
      templateId,
      name: "Review",
      nodeType: "normal",
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });

    // Blocker is Done-status but stuck on a non-`end` workflow node (the desync).
    const blockerDoneId = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Merged foundation", issueNumber: 1 });
    await db.update(issues).set({ currentNodeId: stuckNodeId }).where(eq(issues.id, blockerDoneId));

    const dependent = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Needs foundation", issueNumber: 2 });
    await insertDependency(db, dependent, blockerDoneId);

    const plan = await buildDependencyWavePlan(db, projectId, { wipLimit: 5 });

    // The Done blocker should be resolved; the dependent should be in readyNow.
    expect(plan.readyNow.map((i) => i.id)).toContain(dependent);
    expect(plan.blocked.map((i) => i.id)).not.toContain(dependent);
  });

  // #784/#798: the wave planner now shares computeBlockerReadiness, so a Done blocker
  // whose workspace is closed-but-unmerged (mergedAt null, not direct) does NOT unblock
  // its dependent — the work isn't on the base branch yet.
  it("keeps a dependent blocked when its Done blocker is closed-but-unmerged (#784)", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const blockerDone = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Foundation (unmerged)", issueNumber: 1 });
    const dependent = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Needs foundation", issueNumber: 2 });
    await insertDependency(db, dependent, blockerDone);
    // Workspace closed at the Done transition, but its branch→base merge is still queued.
    await insertWorkspace(db, { issueId: blockerDone, branch: "feature/ak-1-foundation", mergedAt: null, isDirect: false });

    const plan = await buildDependencyWavePlan(db, projectId, { wipLimit: 5 });

    expect(plan.blocked.map((i) => i.id)).toContain(dependent);
    expect(plan.readyNow.map((i) => i.id)).not.toContain(dependent);
    const blockedDep = plan.blocked.find((i) => i.id === dependent);
    expect(blockedDep?.blockers).toEqual([
      expect.objectContaining({ issueId: blockerDone, issueNumber: 1 }),
    ]);

    // Once the blocker's merge lands, the dependent becomes ready.
    await db.update(workspaces).set({ mergedAt: new Date().toISOString() }).where(eq(workspaces.issueId, blockerDone));
    const planAfter = await buildDependencyWavePlan(db, projectId, { wipLimit: 5 });
    expect(planAfter.readyNow.map((i) => i.id)).toContain(dependent);
  });

  // #782/#798: a fan-in dependent depends on TWO blockers; it stays blocked until BOTH
  // land on the base branch, then becomes ready.
  it("keeps a fan-in dependent blocked until every blocker lands (#782)", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const blockerA = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Foundation A", issueNumber: 1 });
    const blockerB = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Foundation B", issueNumber: 2 });
    const fanIn = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Integrates A and B", issueNumber: 3 });
    await insertDependency(db, fanIn, blockerA);
    await insertDependency(db, fanIn, blockerB);
    // A is merged; B is closed-but-unmerged.
    await insertWorkspace(db, { issueId: blockerA, branch: "feature/ak-1-a", mergedAt: new Date().toISOString() });
    await insertWorkspace(db, { issueId: blockerB, branch: "feature/ak-2-b", mergedAt: null, isDirect: false });

    const plan = await buildDependencyWavePlan(db, projectId, { wipLimit: 5 });
    expect(plan.blocked.map((i) => i.id)).toContain(fanIn);
    // Only the un-landed blocker (B) is reported, not the already-merged A.
    const blockedFanIn = plan.blocked.find((i) => i.id === fanIn);
    expect(blockedFanIn?.blockers.map((b) => b.issueId)).toEqual([blockerB]);

    // Land B too — now the fan-in dependent is ready.
    await db.update(workspaces).set({ mergedAt: new Date().toISOString() }).where(eq(workspaces.issueId, blockerB));
    const planAfter = await buildDependencyWavePlan(db, projectId, { wipLimit: 5 });
    expect(planAfter.readyNow.map((i) => i.id)).toContain(fanIn);
    expect(planAfter.blocked.map((i) => i.id)).not.toContain(fanIn);
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

  it("forwards planMode:false so wave-launched builders start in execute mode (#767)", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Ready one", issueNumber: 1 });
    const createWorkspace = vi.fn(async (issue: { id: string }) => ({ id: `ws-${issue.id}` }));

    await startNextDependencyWave(db, projectId, { createWorkspace });

    expect(createWorkspace).toHaveBeenCalledTimes(1);
    // Wave builders must skip plan mode (matching the New-Workspace execute default),
    // otherwise a codex builder burns minutes planning and trips stall detection.
    expect(createWorkspace.mock.calls[0][1]).toEqual({ planMode: false });
  });
});
