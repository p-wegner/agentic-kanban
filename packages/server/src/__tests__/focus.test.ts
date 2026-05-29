import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { createFocusRoute } from "../routes/focus.js";
import * as schema from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/focus", createFocusRoute(db));
  });
}

async function seedProject(db: TestDb, name: string) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.projects).values({
    id, name, repoPath: `/tmp/${name}`, repoName: name,
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return id;
}

async function seedStatus(db: TestDb, projectId: string, name: string, sortOrder: number) {
  const id = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id, projectId, name, sortOrder, isDefault: sortOrder === 0, createdAt: new Date().toISOString(),
  });
  return id;
}

async function seedIssue(
  db: TestDb,
  projectId: string,
  statusId: string,
  fields: { issueNumber: number; title: string; priority?: string; estimate?: string | null },
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.issues).values({
    id,
    projectId,
    statusId,
    issueNumber: fields.issueNumber,
    title: fields.title,
    priority: fields.priority ?? "medium",
    issueType: "task",
    estimate: fields.estimate ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedDependency(db: TestDb, issueId: string, dependsOnId: string, type = "depends_on") {
  await db.insert(schema.issueDependencies).values({
    id: randomUUID(),
    issueId,
    dependsOnId,
    type,
    createdAt: new Date().toISOString(),
  });
}

describe("Focus — what should I work on next", () => {
  const { app, db } = createTestApp();
  let projectId: string;
  let todoId: string;
  let inProgressId: string;
  let doneId: string;
  // issues
  let foundation: string; // blocks two others
  let feature: string; // depends on foundation
  let polish: string; // depends on feature

  beforeAll(async () => {
    projectId = await seedProject(db, "focus-proj");
    todoId = await seedStatus(db, projectId, "Todo", 0);
    inProgressId = await seedStatus(db, projectId, "In Progress", 1);
    doneId = await seedStatus(db, projectId, "Done", 2);

    // A small, high-priority, ready ticket that transitively unblocks two others.
    foundation = await seedIssue(db, projectId, todoId, {
      issueNumber: 1, title: "Foundation", priority: "high", estimate: "s",
    });
    feature = await seedIssue(db, projectId, todoId, {
      issueNumber: 2, title: "Feature on top", priority: "medium", estimate: "m",
    });
    polish = await seedIssue(db, projectId, todoId, {
      issueNumber: 3, title: "Polish", priority: "low", estimate: "m",
    });
    // A standalone ready ticket with no leverage.
    await seedIssue(db, projectId, todoId, {
      issueNumber: 4, title: "Standalone chore", priority: "low", estimate: "xl",
    });
    // An issue already in progress — should be excluded from "ready".
    await seedIssue(db, projectId, inProgressId, {
      issueNumber: 5, title: "Already underway", priority: "critical", estimate: "xs",
    });

    // feature depends on foundation; polish depends on feature.
    await seedDependency(db, feature, foundation);
    await seedDependency(db, polish, feature);
  });

  it("requires projectId", async () => {
    const res = await app.request("/api/focus");
    expect(res.status).toBe(400);
  });

  it("ranks the high-leverage ready ticket first and excludes in-flight work", async () => {
    const res = await app.request(`/api/focus?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    // Foundation unblocks feature AND polish (transitively) → highest leverage.
    expect(body.ready[0].issueNumber).toBe(1);
    expect(body.ready[0].unblocks).toBe(2);
    expect(body.ready[0].reasons).toContain("unblocks 2 issues");

    const readyNumbers = body.ready.map((i: any) => i.issueNumber);
    // #4 standalone is ready; #5 is in progress (excluded); #2/#3 are blocked.
    expect(readyNumbers).toContain(1);
    expect(readyNumbers).toContain(4);
    expect(readyNumbers).not.toContain(5);
    expect(readyNumbers).not.toContain(2);
    expect(readyNumbers).not.toContain(3);

    expect(body.headline.inFlightCount).toBe(1);
    expect(body.headline.topScore).toBe(body.ready[0].focusScore);
  });

  it("lists blocked issues separately with their open blockers", async () => {
    const res = await app.request(`/api/focus?projectId=${projectId}`);
    const body = await res.json() as any;

    const blockedNumbers = body.blocked.map((i: any) => i.issueNumber);
    expect(blockedNumbers).toContain(2);
    expect(blockedNumbers).toContain(3);

    const feat = body.blocked.find((i: any) => i.issueNumber === 2);
    expect(feat.blockedBy.some((b: any) => b.issueNumber === 1)).toBe(true);
  });

  it("a blocker moving to Done unblocks its dependents", async () => {
    // Move foundation (#1) to Done — #2 should become ready, and #1's leverage
    // (now a done issue) drops out of the ready list entirely.
    await db.update(schema.issues)
      .set({ statusId: doneId })
      .where(eq(schema.issues.id, foundation));

    const res = await app.request(`/api/focus?projectId=${projectId}`);
    const body = await res.json() as any;

    const readyNumbers = body.ready.map((i: any) => i.issueNumber);
    expect(readyNumbers).not.toContain(1); // done, no longer a candidate
    expect(readyNumbers).toContain(2); // its only blocker is resolved

    // #2 still transitively unblocks #3, so it carries leverage now.
    const feat = body.ready.find((i: any) => i.issueNumber === 2);
    expect(feat.unblocks).toBe(1);

    // #3 is still blocked by #2 (which is open again as a non-done blocker).
    const blockedNumbers = body.blocked.map((i: any) => i.issueNumber);
    expect(blockedNumbers).toContain(3);
  });
});
