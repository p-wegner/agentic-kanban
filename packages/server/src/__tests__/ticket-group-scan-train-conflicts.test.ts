// #1191 — a merge train's member-vs-member conflict clusters are candidate ticket groups
// (decision 015): the tickets' branches collided on the SAME code, which is coupling proven by
// git rather than predicted from a file list. The scan reads what the train persisted in
// `gateEvidence.conflictClusters` and proposes; it never writes an edge unless asked.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { issueDependencies, issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { scanMergeTrainConflictsForTicketGroups } from "../services/ticket-group-scan.service.js";

async function seedProject(db: TestDb): Promise<{ projectId: string; todoStatusId: string; doneStatusId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const todoStatusId = randomUUID();
  const doneStatusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/train-conflicts-repo", repoName: "train-conflicts-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: todoStatusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  return { projectId, todoStatusId, doneStatusId };
}

/** One issue with one workspace; returns both ids. */
async function seedTicket(
  db: TestDb,
  args: { projectId: string; statusId: string; issueNumber: number },
): Promise<{ issueId: string; workspaceId: string }> {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId, issueNumber: args.issueNumber, title: `Ticket ${args.issueNumber}`,
    statusId: args.statusId, projectId: args.projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: `feature/ak-${args.issueNumber}` });
  return { issueId, workspaceId };
}

async function seedTrain(db: TestDb, projectId: string, label: string, clusters: string[][]): Promise<void> {
  const id = randomUUID();
  await createMergeTrain({ id, projectId, label, memberWorkspaceIds: clusters.flat() }, db);
  await updateMergeTrainState(id, {
    state: "landed",
    gateEvidence: { gateRuns: 1, conflictClusters: clusters.map((workspaceIds) => ({ workspaceIds })) },
  }, db);
}

describe("scanMergeTrainConflictsForTicketGroups (#1191)", () => {
  it("proposes one group per conflict cluster, naming the train in the rationale, and writes nothing", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const t1 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 1 });
    const t2 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 2 });
    const t3 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 3 });
    await seedTrain(db, projectId, "q1", [[t1.workspaceId, t2.workspaceId]]);

    const result = await scanMergeTrainConflictsForTicketGroups(projectId, db);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].issueNumbers).toEqual([1, 2]);
    expect(result.proposals[0].rationale).toContain("merge train q1");
    expect(result.proposals.flatMap((p) => p.issueIds)).not.toContain(t3.issueId);
    expect(result.createdEdges).toBeUndefined();
    expect(await db.select().from(issueDependencies)).toEqual([]);
  });

  it("unions clusters across trains into one component and lists every train that saw the pair", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const t1 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 1 });
    const t2 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 2 });
    const t3 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 3 });
    await seedTrain(db, projectId, "q1", [[t1.workspaceId, t2.workspaceId]]);
    await seedTrain(db, projectId, "q2", [[t2.workspaceId, t3.workspaceId]]);

    const result = await scanMergeTrainConflictsForTicketGroups(projectId, db);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].issueNumbers).toEqual([1, 2, 3]);
    expect(result.proposals[0].rationale).toContain("trains ");
    expect(result.proposals[0].rationale).toContain("q1");
    expect(result.proposals[0].rationale).toContain("q2");
  });

  it("rejects a cluster whose other members already landed or closed, rather than proposing a singleton", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId, doneStatusId } = await seedProject(db);
    const t1 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 1 });
    const t2 = await seedTicket(db, { projectId, statusId: doneStatusId, issueNumber: 2 });
    await seedTrain(db, projectId, "q1", [[t1.workspaceId, t2.workspaceId]]);

    const result = await scanMergeTrainConflictsForTicketGroups(projectId, db);

    expect(result.proposals).toEqual([]);
    expect(result.rejected).toEqual([{ issueNumbers: [1, 2], reason: "train q1: all but one member already landed or closed" }]);
  });

  it("never groups across a sequential depends_on edge", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const t1 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 1 });
    const t2 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 2 });
    await db.insert(issueDependencies).values({
      id: randomUUID(), issueId: t2.issueId, dependsOnId: t1.issueId, type: "depends_on", createdAt: new Date().toISOString(),
    });
    await seedTrain(db, projectId, "q1", [[t1.workspaceId, t2.workspaceId]]);

    const result = await scanMergeTrainConflictsForTicketGroups(projectId, db);

    expect(result.proposals).toEqual([]);
  });

  it("returns an empty scan when no train recorded a cluster", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const t1 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 1 });
    const id = randomUUID();
    await createMergeTrain({ id, projectId, label: "q0", memberWorkspaceIds: [t1.workspaceId] }, db);
    await updateMergeTrainState(id, { state: "landed", gateEvidence: { gateRuns: 1 } }, db);

    expect(await scanMergeTrainConflictsForTicketGroups(projectId, db)).toEqual({ proposals: [], rejected: [], scannedCount: 0 });
  });

  it("apply=true writes the coupled_with edges, once", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const t1 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 1 });
    const t2 = await seedTicket(db, { projectId, statusId: todoStatusId, issueNumber: 2 });
    await seedTrain(db, projectId, "q1", [[t1.workspaceId, t2.workspaceId]]);

    const first = await scanMergeTrainConflictsForTicketGroups(projectId, db, { apply: true });
    expect(first.createdEdges).toBe(1);
    const coupled = (await db.select().from(issueDependencies)).filter((e) => e.type === "coupled_with");
    expect(coupled).toHaveLength(1);
    expect([coupled[0].issueId, coupled[0].dependsOnId].sort()).toEqual([t1.issueId, t2.issueId].sort());

    // The pair is now coupled: a second scan still shows it (informational) but writes no edge.
    const second = await scanMergeTrainConflictsForTicketGroups(projectId, db, { apply: true });
    expect(second.proposals[0].alreadyCoupledPairs).toBe(1);
    expect(second.createdEdges).toBe(0);
    expect((await db.select().from(issueDependencies)).filter((e) => e.type === "coupled_with")).toHaveLength(1);
  });
});
