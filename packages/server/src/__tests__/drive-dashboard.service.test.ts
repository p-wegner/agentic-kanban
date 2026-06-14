import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boardHealthEvents,
  drives,
  issueDependencies,
  issues,
  preferences,
  projectStatuses,
  projects,
} from "@agentic-kanban/shared/schema";
import { buildDriveDashboard } from "../services/drive-dashboard.service.js";
import { DriveError } from "../services/drive.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Drive Project",
    repoPath: "/tmp/drive-project",
    repoName: "drive-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [index, name] of ["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"].entries()) {
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
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: input.issueNumber,
    title: input.title,
    priority: "medium",
    issueType: "task",
    sortOrder: input.issueNumber,
    statusId: input.statusId,
    projectId: input.projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function insertDependency(db: TestDb, issueId: string, dependsOnId: string, type: string) {
  await db.insert(issueDependencies).values({
    id: randomUUID(),
    issueId,
    dependsOnId,
    type: type as "depends_on",
    createdAt: new Date().toISOString(),
  });
}

async function createDriveRecord(db: TestDb, projectId: string, metaIssueId: string | null) {
  const id = randomUUID();
  await db.insert(drives).values({
    id,
    projectId,
    metaIssueId,
    target: "Build the thing",
    completionContract: null,
    status: "active",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
  return id;
}

describe("drive dashboard service", () => {
  it("computes progress, tiers, and stalls over the drive's parent_of children", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);

    const epic = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "EPIC", issueNumber: 100 });
    // tier 0 foundation (Done), tier 1 depends on it (In Progress), tier 2 blocked by tier 1 (Todo)
    const foundation = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Foundation", issueNumber: 1 });
    const tier1 = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "Builds on foundation", issueNumber: 2 });
    const tier2 = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Needs tier1", issueNumber: 3 });

    await insertDependency(db, epic, foundation, "parent_of");
    await insertDependency(db, epic, tier1, "parent_of");
    await insertDependency(db, epic, tier2, "parent_of");
    await insertDependency(db, tier1, foundation, "depends_on");
    await insertDependency(db, tier2, tier1, "depends_on");

    const driveId = await createDriveRecord(db, projectId, epic);
    const dash = await buildDriveDashboard(db, projectId, driveId);

    // progress: 3 scoped issues (epic excluded), 1 done
    expect(dash.progress.total).toBe(3);
    expect(dash.progress.done).toBe(1);
    expect(dash.progress.inProgress).toBe(1);
    expect(dash.progress.todo).toBe(1);
    expect(dash.progress.percentDone).toBe(33);

    // tiers: foundation=0, tier1=1, tier2=2
    const tierOf = (issueNumber: number) =>
      dash.tiers.flatMap((t) => t.issues).find((i) => i.issueNumber === issueNumber)?.tier;
    expect(tierOf(1)).toBe(0);
    expect(tierOf(2)).toBe(1);
    expect(tierOf(3)).toBe(2);

    // stalls: tier2 is blocked by open tier1 (foundation is Done so tier1 is NOT stalled by it)
    const stallNumbers = dash.stalls.map((s) => s.issueNumber);
    expect(stallNumbers).toContain(3);
    expect(stallNumbers).not.toContain(2);
    const tier2Stall = dash.stalls.find((s) => s.issueNumber === 3);
    expect(tier2Stall?.blockedBy.map((b) => b.issueNumber)).toEqual([2]);
  });

  it("surfaces the latest merge health event as last cascade and build-clean prefs", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const epic = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "EPIC", issueNumber: 200 });
    const driveId = await createDriveRecord(db, projectId, epic);

    await db.insert(boardHealthEvents).values({
      id: randomUUID(),
      projectId,
      cycleId: "c1",
      eventType: "action",
      category: "merge",
      issueNumber: 42,
      summary: "Merged #42 into main",
      details: null,
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });
    await db.insert(preferences).values({ key: `cold_clone_check_${projectId}`, value: "true" });
    await db.insert(preferences).values({ key: `verify_script_${projectId}`, value: "pnpm test" });

    const dash = await buildDriveDashboard(db, projectId, driveId);
    expect(dash.lastCascade?.issueNumber).toBe(42);
    expect(dash.lastCascade?.summary).toContain("Merged");
    expect(dash.buildClean.coldCloneGateEnabled).toBe(true);
    expect(dash.buildClean.verifyGateConfigured).toBe(true);
  });

  it("returns an empty scope when the drive has no meta issue", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const driveId = await createDriveRecord(db, projectId, null);
    const dash = await buildDriveDashboard(db, projectId, driveId);
    expect(dash.progress.total).toBe(0);
    expect(dash.tiers).toEqual([]);
    expect(dash.stalls).toEqual([]);
  });

  it("rejects a drive from another project", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);
    const driveId = await createDriveRecord(db, projectId, null);
    await expect(buildDriveDashboard(db, randomUUID(), driveId)).rejects.toBeInstanceOf(DriveError);
  });
});
