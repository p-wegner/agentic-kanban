/**
 * #918 — contract is the documented INVERSE of decomposeEpic. `confirmContractComponent`
 * collapses a coupled component (coupled_with peers) onto a survivor: the survivor takes the
 * merged title/description, absorbed members are Cancelled with a pointer back, the internal
 * coupled_with edges are dropped, and external sequential deps inherit onto the survivor
 * (the #916 contraction invariant, via the shared planContraction planner).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { confirmContractComponent } from "../services/issue-ai.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const backlogId = randomUUID();
  const cancelledId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: backlogId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now },
    { id: cancelledId, projectId, name: "Cancelled", sortOrder: 9, isDefault: false, createdAt: now },
  ]);
  return { projectId, backlogId, cancelledId };
}

async function insertIssue(db: Db, projectId: string, statusId: string, issueNumber: number, title: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id, issueNumber, title, description: `${title} body`, priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  return id;
}

async function coupled(db: Db, a: string, b: string) {
  await db.insert(schema.issueDependencies).values({
    id: randomUUID(), issueId: a, dependsOnId: b, type: "coupled_with", createdAt: new Date().toISOString(),
  });
}

describe("confirmContractComponent", () => {
  it("keeps the survivor, Cancels absorbed members, drops internal coupled_with edges", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId, cancelledId } = await seedProject(db);
    const a = await insertIssue(db, projectId, backlogId, 1, "Panel UI");
    const b = await insertIssue(db, projectId, backlogId, 2, "Panel endpoint");
    await coupled(db, a, b);

    const result = await confirmContractComponent(
      { projectId, survivorId: a, memberIds: [a, b], mergedTitle: "Panel (UI + endpoint)", mergedDescription: "Merged body" },
      db as any,
    );

    expect(result.survivorId).toBe(a);
    expect(result.absorbedIds).toEqual([b]);

    const survivor = (await db.select().from(schema.issues).where(eq(schema.issues.id, a)))[0];
    expect(survivor.title).toBe("Panel (UI + endpoint)");
    expect(survivor.description).toBe("Merged body");
    expect(survivor.statusId).toBe(backlogId); // survivor stays open

    const absorbed = (await db.select().from(schema.issues).where(eq(schema.issues.id, b)))[0];
    expect(absorbed.statusId).toBe(cancelledId);
    expect(absorbed.description).toContain("Contracted into #1");

    // internal coupled_with edge dropped
    const coupledEdges = await db.select().from(schema.issueDependencies)
      .where(eq(schema.issueDependencies.type, "coupled_with"));
    expect(coupledEdges).toHaveLength(0);
  });

  it("inherits an external depends_on edge from an absorbed member onto the survivor", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedProject(db);
    const a = await insertIssue(db, projectId, backlogId, 1, "Survivor");
    const b = await insertIssue(db, projectId, backlogId, 2, "Absorbed");
    const x = await insertIssue(db, projectId, backlogId, 3, "External dep");
    await coupled(db, a, b);
    // Absorbed member b depends_on external x — must repoint onto survivor a.
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: b, dependsOnId: x, type: "depends_on", createdAt: new Date().toISOString(),
    });

    await confirmContractComponent(
      { projectId, survivorId: a, memberIds: [a, b], mergedTitle: "Merged", mergedDescription: "" },
      db as any,
    );

    const deps = await db.select().from(schema.issueDependencies)
      .where(and(eq(schema.issueDependencies.type, "depends_on"), inArray(schema.issueDependencies.issueId, [a, b])));
    // old b->x removed, survivor a->x added (no dangling edge to the absorbed member)
    expect(deps).toHaveLength(1);
    expect(deps[0].issueId).toBe(a);
    expect(deps[0].dependsOnId).toBe(x);
  });

  it("refuses to absorb a component with an open workspace", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedProject(db);
    const a = await insertIssue(db, projectId, backlogId, 1, "A");
    const b = await insertIssue(db, projectId, backlogId, 2, "B");
    await coupled(db, a, b);
    const now = new Date().toISOString();
    await db.insert(schema.workspaces).values({
      id: randomUUID(), issueId: b, status: "active", branch: "feature/x", workingDir: "/tmp/x",
      createdAt: now, updatedAt: now,
    });

    await expect(
      confirmContractComponent(
        { projectId, survivorId: a, memberIds: [a, b], mergedTitle: "M", mergedDescription: "" },
        db as any,
      ),
    ).rejects.toThrow(/open workspace/);
  });

  it("rejects members from another project without mutating them", async () => {
    const { db } = createTestDb();
    const p1 = await seedProject(db);
    const p2 = await seedProject(db);
    const a = await insertIssue(db, p1.projectId, p1.backlogId, 1, "Project one survivor");
    const b = await insertIssue(db, p2.projectId, p2.backlogId, 2, "Project two absorbed");

    await expect(
      confirmContractComponent(
        { projectId: p1.projectId, survivorId: a, memberIds: [a, b], mergedTitle: "Merged", mergedDescription: "Merged body" },
        db as any,
      ),
    ).rejects.toThrow(/target project/);

    const survivor = (await db.select().from(schema.issues).where(eq(schema.issues.id, a)))[0];
    const otherProjectIssue = (await db.select().from(schema.issues).where(eq(schema.issues.id, b)))[0];
    expect(survivor.title).toBe("Project one survivor");
    expect(otherProjectIssue.statusId).toBe(p2.backlogId);
    expect(otherProjectIssue.description).toBe("Project two absorbed body");
  });

  it("rejects a survivor that is not among the members", async () => {
    const { db } = createTestDb();
    const { projectId, backlogId } = await seedProject(db);
    const a = await insertIssue(db, projectId, backlogId, 1, "A");
    const b = await insertIssue(db, projectId, backlogId, 2, "B");
    await expect(
      confirmContractComponent(
        { projectId, survivorId: "not-a-member", memberIds: [a, b], mergedTitle: "M", mergedDescription: "" },
        db as any,
      ),
    ).rejects.toThrow(/survivorId must be one of memberIds/);
  });
});
