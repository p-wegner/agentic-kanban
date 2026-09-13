import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  drives,
  issueDependencies,
  issues,
  projectStatuses,
  projects,
} from "@agentic-kanban/shared/schema";
import { buildDriveMap } from "../services/drive-membership.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Drive Project",
    repoPath: "/tmp/drive-membership-project",
    repoName: "drive-membership-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [index, name] of ["Backlog", "Todo", "In Progress", "Done"].entries()) {
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

async function createDriveRecord(
  db: TestDb,
  projectId: string,
  metaIssueId: string | null,
  opts: { target?: string; status?: "active" | "completed" | "abandoned" } = {},
) {
  const id = randomUUID();
  await db.insert(drives).values({
    id,
    projectId,
    metaIssueId,
    target: opts.target ?? "Build the thing",
    completionContract: null,
    status: opts.status ?? "active",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
  return id;
}

describe("buildDriveMap", () => {
  it("maps an epic's parent_of children (and the epic itself) to their drive", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);

    const epic = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "EPIC", issueNumber: 100 });
    const child1 = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Child 1", issueNumber: 1 });
    const child2 = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "Child 2", issueNumber: 2 });
    const outsider = await insertIssue(db, { projectId, statusId: statusIds.Backlog, title: "Unrelated", issueNumber: 3 });

    await insertDependency(db, epic, child1, "parent_of");
    await insertDependency(db, epic, child2, "parent_of");

    const driveId = await createDriveRecord(db, projectId, epic, { target: "Ship the drive" });

    const map = await buildDriveMap(projectId, db);

    expect(map.get(child1)).toEqual({ id: driveId, target: "Ship the drive" });
    expect(map.get(child2)).toEqual({ id: driveId, target: "Ship the drive" });
    expect(map.get(epic)).toEqual({ id: driveId, target: "Ship the drive" });
    expect(map.has(outsider)).toBe(false);
  });

  it("returns an empty map when the project has no active drives", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);

    const map = await buildDriveMap(projectId, db);

    expect(map.size).toBe(0);
  });

  it("ignores a drive with no meta issue and a non-active drive", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const epic = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "EPIC", issueNumber: 1 });
    const child = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Child", issueNumber: 2 });
    await insertDependency(db, epic, child, "parent_of");

    await createDriveRecord(db, projectId, null);
    await createDriveRecord(db, projectId, epic, { status: "completed" });

    const map = await buildDriveMap(projectId, db);

    expect(map.size).toBe(0);
  });

  it("falls back to every outgoing edge when the meta issue has no parent_of edges", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const epic = await insertIssue(db, { projectId, statusId: statusIds["In Progress"], title: "EPIC", issueNumber: 1 });
    const child = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "Child", issueNumber: 2 });
    await insertDependency(db, epic, child, "depends_on");

    const driveId = await createDriveRecord(db, projectId, epic);

    const map = await buildDriveMap(projectId, db);

    expect(map.get(child)).toEqual({ id: driveId, target: "Build the thing" });
  });
});
