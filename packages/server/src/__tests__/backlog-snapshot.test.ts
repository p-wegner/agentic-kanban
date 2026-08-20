import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, tags, issueTags, milestones, issueDependencies } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  exportBacklogSnapshot,
  importBacklogSnapshot,
  validateBacklogSnapshot,
  BACKLOG_SNAPSHOT_KIND,
} from "../services/backlog-snapshot.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

const STATUS_NAMES = ["Backlog", "Todo", "In Progress", "Done"];

async function seedProject(db: Db, name: string): Promise<{ projectId: string; statusIds: Record<string, string> }> {
  const projectId = randomUUID();
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  await db.insert(projects).values({ id: projectId, name, repoPath: `/tmp/${name}`, repoName: name, createdAt: now, updatedAt: now });
  const statusIds: Record<string, string> = {};
  for (let i = 0; i < STATUS_NAMES.length; i++) {
    const id = randomUUID();
    statusIds[STATUS_NAMES[i]] = id;
    await db.insert(projectStatuses).values({ id, projectId, name: STATUS_NAMES[i], sortOrder: i - 1, isDefault: STATUS_NAMES[i] === "Todo", createdAt: now });
  }
  return { projectId, statusIds };
}

async function seedRichBacklog(db: Db) {
  const { projectId, statusIds } = await seedProject(db, "source-project");
  const now = new Date("2026-02-01T00:00:00.000Z").toISOString();

  const milestoneId = randomUUID();
  await db.insert(milestones).values({ id: milestoneId, projectId, name: "M1", dueDate: "2026-03-01", createdAt: now });

  const tagBug = randomUUID();
  const tagUi = randomUUID();
  await db.insert(tags).values([
    { id: tagBug, name: "bug", color: "#f00", createdAt: now },
    { id: tagUi, name: "ui", color: "#00f", createdAt: now },
  ]);

  const i1 = randomUUID();
  const i2 = randomUUID();
  const i3 = randomUUID();
  await db.insert(issues).values([
    { id: i1, issueNumber: 1, title: "First issue", description: "desc one", priority: "high", issueType: "feature", sortOrder: 0, statusId: statusIds["Backlog"], projectId, createdAt: now, updatedAt: now, statusChangedAt: now, milestoneId, checklistJson: JSON.stringify([{ id: "a", text: "do x", completed: false }]), pinned: true },
    { id: i2, issueNumber: 2, title: "Second issue", description: null, priority: "medium", issueType: "bug", sortOrder: 1, statusId: statusIds["Todo"], projectId, createdAt: now, updatedAt: now },
    { id: i3, issueNumber: 3, title: "Third issue", description: "done work", priority: "low", issueType: "task", sortOrder: 2, statusId: statusIds["Done"], projectId, createdAt: now, updatedAt: now },
  ]);

  await db.insert(issueTags).values([
    { id: randomUUID(), issueId: i1, tagId: tagUi },
    { id: randomUUID(), issueId: i2, tagId: tagBug },
  ]);

  // #2 depends_on #1; #3 related_to #1
  await db.insert(issueDependencies).values([
    { id: randomUUID(), issueId: i2, dependsOnId: i1, type: "depends_on", createdAt: now },
    { id: randomUUID(), issueId: i3, dependsOnId: i1, type: "related_to", createdAt: now },
  ]);

  return { projectId, statusIds };
}

describe("backlog snapshot export", () => {
  it("captures issues, tags, milestones, dependencies keyed by name/number", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedRichBacklog(db);

    const snap = await exportBacklogSnapshot(projectId, db, { now: "2026-05-05T00:00:00.000Z" });

    expect(snap.kind).toBe(BACKLOG_SNAPSHOT_KIND);
    expect(snap.project.name).toBe("source-project");
    expect(snap.issues).toHaveLength(3);
    expect(snap.statuses.map((s) => s.name)).toEqual(STATUS_NAMES);
    expect(snap.milestones).toEqual([{ name: "M1", dueDate: "2026-03-01" }]);

    const first = snap.issues.find((i) => i.issueNumber === 1)!;
    expect(first.status).toBe("Backlog");
    expect(first.milestone).toBe("M1");
    expect(first.pinned).toBe(true);
    expect(first.tags).toEqual(["ui"]);
    expect(first.checklistJson).toContain("do x");

    // Only tags actually used are exported.
    expect(snap.tags.map((t) => t.name).sort()).toEqual(["bug", "ui"]);

    expect(snap.dependencies).toContainEqual({ fromNumber: 2, toNumber: 1, type: "depends_on" });
    expect(snap.dependencies).toContainEqual({ fromNumber: 3, toNumber: 1, type: "related_to" });
  });
});

describe("backlog snapshot import", () => {
  it("round-trips into a differently-registered project (new ids, same names/numbers)", async () => {
    const { db } = createTestDb();
    const { projectId: sourceId } = await seedRichBacklog(db);
    const snap = await exportBacklogSnapshot(sourceId, db);

    // Target project has its OWN status ids but the same status names, and is empty.
    const { projectId: targetId } = await seedProject(db, "target-project");

    const result = await importBacklogSnapshot(targetId, snap, db);
    expect(result.createdIssues).toBe(3);
    expect(result.createdDependencies).toBe(2);
    expect(result.skippedDependencies).toBe(0);

    // Re-export the target and compare the meaningful fields.
    const reexport = await exportBacklogSnapshot(targetId, db);
    expect(reexport.issues.map((i) => i.issueNumber).sort()).toEqual([1, 2, 3]);

    const t1 = reexport.issues.find((i) => i.issueNumber === 1)!;
    expect(t1.status).toBe("Backlog");
    expect(t1.milestone).toBe("M1");
    expect(t1.tags).toEqual(["ui"]);
    expect(t1.pinned).toBe(true);
    expect(reexport.dependencies).toContainEqual({ fromNumber: 2, toNumber: 1, type: "depends_on" });
    expect(reexport.dependencies).toContainEqual({ fromNumber: 3, toNumber: 1, type: "related_to" });
  });

  it("renumbers colliding issue numbers and preserves free ones", async () => {
    const { db } = createTestDb();
    const { projectId: sourceId } = await seedRichBacklog(db);
    const snap = await exportBacklogSnapshot(sourceId, db);

    // Target already has issue #1 → the imported #1 must be renumbered, #2/#3 kept.
    const { projectId: targetId, statusIds } = await seedProject(db, "target-with-existing");
    await db.insert(issues).values({ id: randomUUID(), issueNumber: 1, title: "pre-existing", priority: "medium", issueType: "task", sortOrder: 0, statusId: statusIds["Todo"], projectId: targetId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    const result = await importBacklogSnapshot(targetId, snap, db);
    expect(result.createdIssues).toBe(3);

    const reexport = await exportBacklogSnapshot(targetId, db);
    const numbers = reexport.issues.map((i) => i.issueNumber).sort((a, b) => (a ?? 0) - (b ?? 0));
    // pre-existing #1, kept #2 #3, and the renumbered former-#1 → #4.
    expect(numbers).toEqual([1, 2, 3, 4]);
    // Dependencies still wire correctly despite the renumber.
    expect(result.createdDependencies).toBe(2);
  });

  it("creates missing statuses by name instead of dropping issues", async () => {
    const { db } = createTestDb();
    const { projectId: sourceId } = await seedRichBacklog(db);
    const snap = await exportBacklogSnapshot(sourceId, db);

    // Target project only has 'Todo' — 'Backlog'/'Done'/'In Progress' are missing.
    const targetId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(projects).values({ id: targetId, name: "sparse-target", repoPath: "/tmp/sparse", repoName: "sparse", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: randomUUID(), projectId: targetId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });

    const result = await importBacklogSnapshot(targetId, snap, db);
    expect(result.createdIssues).toBe(3);
    expect(result.createdStatuses).toContain("Backlog");
    expect(result.createdStatuses).toContain("Done");

    const reexport = await exportBacklogSnapshot(targetId, db);
    expect(reexport.issues.find((i) => i.issueNumber === 1)!.status).toBe("Backlog");
    expect(reexport.issues.find((i) => i.issueNumber === 3)!.status).toBe("Done");
  });
});

describe("validateBacklogSnapshot", () => {
  it("rejects a non-object and a missing issues array", () => {
    expect(validateBacklogSnapshot(null).errors.length).toBeGreaterThan(0);
    expect(validateBacklogSnapshot({ issues: "nope" }).errors.length).toBeGreaterThan(0);
  });

  it("rejects an issue without a title but accepts a minimal valid snapshot", () => {
    const bad = validateBacklogSnapshot({ issues: [{ description: "x" }] });
    expect(bad.snapshot).toBeNull();
    expect(bad.errors.some((e) => e.includes("title"))).toBe(true);

    const ok = validateBacklogSnapshot({ issues: [{ title: "hi", status: "Todo" }] });
    expect(ok.errors).toHaveLength(0);
    expect(ok.snapshot!.issues[0].title).toBe("hi");
    expect(ok.snapshot!.issues[0].priority).toBe("medium");
  });
});
