// #918 — seed coupled_with from touchedFilesJson so ticket groups form on a cold backlog
// with zero coupled_with edges and no LLM call.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { issueDependencies, issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { scanTouchedFilesForTicketGroups } from "../services/ticket-group-scan.service.js";

async function seedProject(db: TestDb): Promise<{ projectId: string; todoStatusId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const todoStatusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/touched-files-repo", repoName: "touched-files-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: todoStatusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, todoStatusId };
}

async function seedIssue(
  db: TestDb,
  args: { projectId: string; statusId: string; issueNumber: number; title: string; touchedFiles?: string[] },
): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: args.issueNumber,
    title: args.title,
    statusId: args.statusId,
    projectId: args.projectId,
    createdAt: now,
    updatedAt: now,
    touchedFilesJson: args.touchedFiles
      ? JSON.stringify(args.touchedFiles.map((path) => ({ path, reason: "predicted", confidence: 0.8 })))
      : null,
  });
  return id;
}

describe("scanTouchedFilesForTicketGroups (#918)", () => {
  it("groups tickets sharing >= minSharedFiles predicted files, excluding hot/registration files", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);

    // #1 and #2 share two non-hot files -> should group.
    const issue1 = await seedIssue(db, {
      projectId, statusId: todoStatusId, issueNumber: 1, title: "Add invoice model",
      touchedFiles: ["src/models/invoice.ts", "src/models/invoice.test.ts", "src/app.ts"],
    });
    const issue2 = await seedIssue(db, {
      projectId, statusId: todoStatusId, issueNumber: 2, title: "Add invoice validation",
      touchedFiles: ["src/models/invoice.ts", "src/models/invoice.test.ts", "src/routes.ts"],
    });
    // #3 shares only the hot registration file (app.ts) with #1 -> must NOT group with it.
    const issue3 = await seedIssue(db, {
      projectId, statusId: todoStatusId, issueNumber: 3, title: "Unrelated ticket",
      touchedFiles: ["src/app.ts", "src/other/unrelated.ts"],
    });

    const result = await scanTouchedFilesForTicketGroups(projectId, db);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].issueNumbers).toEqual([1, 2]);
    expect(result.proposals[0].issueIds.sort()).toEqual([issue1, issue2].sort());
    const groupedIds = new Set(result.proposals.flatMap((p) => p.issueIds));
    expect(groupedIds.has(issue3)).toBe(false);
  });

  it("never groups across a sequential depends_on/blocked_by edge", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const now = new Date().toISOString();

    const issueA = await seedIssue(db, {
      projectId, statusId: todoStatusId, issueNumber: 1, title: "A",
      touchedFiles: ["src/models/order.ts", "src/models/order.test.ts"],
    });
    const issueB = await seedIssue(db, {
      projectId, statusId: todoStatusId, issueNumber: 2, title: "B",
      touchedFiles: ["src/models/order.ts", "src/models/order.test.ts"],
    });
    await db.insert(issueDependencies).values({
      id: randomUUID(), issueId: issueB, dependsOnId: issueA, type: "depends_on", createdAt: now,
    });

    const result = await scanTouchedFilesForTicketGroups(projectId, db);
    expect(result.proposals).toHaveLength(0);
  });

  it("caps a component at MAX_TICKET_GROUP_SIZE, splitting the rest into further groups", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    // 5 tickets all sharing the same two non-hot files -> one component of 5,
    // capped into a 4-member group + a leftover reported as rejected (too small to stand alone).
    const sharedFiles = ["src/domain/pricing.ts", "src/domain/pricing.test.ts"];
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await seedIssue(db, {
        projectId, statusId: todoStatusId, issueNumber: i, title: `Pricing ${i}`,
        touchedFiles: sharedFiles,
      }));
    }

    const result = await scanTouchedFilesForTicketGroups(projectId, db);
    // The 5-ticket component is capped at MAX_TICKET_GROUP_SIZE (4): a 4-member group plus a
    // lone leftover, which is correctly dropped (a "group" of 1 is not a group).
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals.every((p) => p.issueIds.length <= 4)).toBe(true);
    expect(result.proposals[0].issueNumbers).toEqual([1, 2, 3, 4]);
  });

  it("apply writes coupled_with edges as a star from the lowest-numbered member", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const issue1 = await seedIssue(db, {
      projectId, statusId: todoStatusId, issueNumber: 1, title: "A",
      touchedFiles: ["src/models/cart.ts", "src/models/cart.test.ts"],
    });
    const issue2 = await seedIssue(db, {
      projectId, statusId: todoStatusId, issueNumber: 2, title: "B",
      touchedFiles: ["src/models/cart.ts", "src/models/cart.test.ts"],
    });

    const result = await scanTouchedFilesForTicketGroups(projectId, db, { apply: true });
    expect(result.createdEdges).toBe(1);

    const edges = await db.select().from(issueDependencies);
    const coupled = edges.filter((e) => e.type === "coupled_with");
    expect(coupled).toHaveLength(1);
    expect([coupled[0].issueId, coupled[0].dependsOnId].sort()).toEqual([issue1, issue2].sort());
  });

  it("returns no proposals when fewer than 2 tickets carry touched-files predictions", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: 1, title: "Only one" });

    const result = await scanTouchedFilesForTicketGroups(projectId, db);
    expect(result.proposals).toHaveLength(0);
  });
});
