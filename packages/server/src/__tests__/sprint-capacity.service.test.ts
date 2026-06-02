import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { buildSprintCapacityPlan } from "../services/sprint-capacity.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Capacity Test Project",
    repoPath: "/tmp/capacity-test",
    repoName: "capacity-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [index, name] of ["Backlog", "Todo", "In Progress", "In Review", "Done"].entries()) {
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
  priority?: string;
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: input.issueNumber,
    title: input.title,
    priority: input.priority ?? "medium",
    issueType: "task",
    sortOrder: input.issueNumber,
    statusId: input.statusId,
    projectId: input.projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function insertWorkspace(db: TestDb, input: {
  issueId: string;
  status: string;
  projectId: string;
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(workspaces).values({
    id,
    issueId: input.issueId,
    projectId: input.projectId,
    branch: `feature/ws-${id.slice(0, 8)}`,
    status: input.status,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function setStrategyConfig(db: TestDb, projectId: string, config: {
  activeAgentsTarget?: number;
  maxNewStartsPerCycle?: number;
  backlogFloor?: number;
}) {
  const key = `board_strategy_${projectId}`;
  const value = JSON.stringify({ version: 1, segments: [], providerPolicies: [], ...config });
  const now = new Date().toISOString();
  await db.insert(preferences).values({ key, value, createdAt: now, updatedAt: now });
}

describe("sprint capacity planner", () => {
  it("returns default policy values when no strategy config exists", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);

    const plan = await buildSprintCapacityPlan(db, projectId);

    expect(plan.policy.activeAgentsTarget).toBe(4);
    expect(plan.policy.maxNewStartsPerCycle).toBe(2);
    expect(plan.policy.backlogFloor).toBe(10);
  });

  it("reads policy values from strategy preference when set", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    await setStrategyConfig(db, projectId, { activeAgentsTarget: 6, maxNewStartsPerCycle: 3, backlogFloor: 5 });

    const plan = await buildSprintCapacityPlan(db, projectId);

    expect(plan.policy.activeAgentsTarget).toBe(6);
    expect(plan.policy.maxNewStartsPerCycle).toBe(3);
    expect(plan.policy.backlogFloor).toBe(5);
  });

  it("counts active workspaces correctly (active/reviewing/fixing/awaiting-plan-approval)", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    await setStrategyConfig(db, projectId, { activeAgentsTarget: 5 });

    const i1 = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Active issue", issueNumber: 1 });
    const i2 = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Reviewing issue", issueNumber: 2 });
    const i3 = await insertIssue(db, { projectId, statusId: statusIds["In Review"], title: "Fixing issue", issueNumber: 3 });
    const i4 = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Idle issue", issueNumber: 4 });
    const i5 = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Closed issue", issueNumber: 5 });

    await insertWorkspace(db, { issueId: i1, projectId, status: "active" });
    await insertWorkspace(db, { issueId: i2, projectId, status: "reviewing" });
    await insertWorkspace(db, { issueId: i3, projectId, status: "fixing" });
    await insertWorkspace(db, { issueId: i4, projectId, status: "idle" });
    await insertWorkspace(db, { issueId: i5, projectId, status: "closed" });

    const plan = await buildSprintCapacityPlan(db, projectId);

    expect(plan.policy.currentActive).toBe(3);
    expect(plan.policy.availableSlots).toBe(2); // 5 target - 3 active
  });

  it("lists backlog issues from Backlog and Todo statuses", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);

    await insertIssue(db, { projectId, statusId: statusIds.Backlog, title: "Backlog Issue", issueNumber: 1 });
    await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Todo Issue", issueNumber: 2 });
    await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "In Progress Issue", issueNumber: 3 });

    const plan = await buildSprintCapacityPlan(db, projectId);

    const titles = plan.nextEligibleIssues.map((i) => i.title);
    expect(titles).toContain("Backlog Issue");
    expect(titles).toContain("Todo Issue");
    expect(titles).not.toContain("In Progress Issue");
  });

  it("flags issues with existing open workspaces as not startable", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);

    const i1 = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Has workspace", issueNumber: 1 });
    const i2 = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "No workspace", issueNumber: 2 });

    await insertWorkspace(db, { issueId: i1, projectId, status: "idle" });

    const plan = await buildSprintCapacityPlan(db, projectId);

    const wsIssue = plan.nextEligibleIssues.find((i) => i.id === i1);
    const freeIssue = plan.nextEligibleIssues.find((i) => i.id === i2);

    expect(wsIssue?.canStart).toBe(false);
    expect(wsIssue?.blockers).toEqual(["Already has an open workspace"]);
    expect(freeIssue?.canStart).toBe(true);
    expect(freeIssue?.blockers).toEqual([]);
  });

  it("computes willStartCount as min of slots, maxNewStartsPerCycle, and available startable issues", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    await setStrategyConfig(db, projectId, { activeAgentsTarget: 5, maxNewStartsPerCycle: 3 });

    // 0 currently active → 5 available slots, cap 3 per cycle, 2 startable issues
    await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Issue A", issueNumber: 1 });
    await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Issue B", issueNumber: 2 });

    const plan = await buildSprintCapacityPlan(db, projectId);

    expect(plan.policy.willStartCount).toBe(2); // min(5 slots, 3 max, 2 startable)
  });

  it("reports zero willStartCount when board is at capacity", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    await setStrategyConfig(db, projectId, { activeAgentsTarget: 2 });

    const i1 = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Active 1", issueNumber: 1 });
    const i2 = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Active 2", issueNumber: 2 });
    await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Queued", issueNumber: 3 });

    await insertWorkspace(db, { issueId: i1, projectId, status: "active" });
    await insertWorkspace(db, { issueId: i2, projectId, status: "active" });

    const plan = await buildSprintCapacityPlan(db, projectId);

    expect(plan.policy.currentActive).toBe(2);
    expect(plan.policy.availableSlots).toBe(0);
    expect(plan.policy.willStartCount).toBe(0);
  });

  it("returns empty nextEligibleIssues for project with no backlog issues", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Only active", issueNumber: 1 });

    const plan = await buildSprintCapacityPlan(db, projectId);
    expect(plan.nextEligibleIssues).toHaveLength(0);
  });
});
