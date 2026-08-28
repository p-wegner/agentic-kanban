// #917 — GET /api/projects/:id/board-monitor/next: read-only top-N ranked start candidates.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createBoardMonitorRoute } from "../routes/board-monitor.js";

async function seedProject(db: TestDb): Promise<{ projectId: string; todoStatusId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const todoStatusId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/board-monitor-next-repo", repoName: "board-monitor-next-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: todoStatusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, todoStatusId };
}

async function seedIssue(
  db: TestDb,
  args: { projectId: string; statusId: string; issueNumber: number; title: string; priority?: string },
): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id, issueNumber: args.issueNumber, title: args.title, statusId: args.statusId, projectId: args.projectId,
    priority: args.priority ?? "medium", createdAt: now, updatedAt: now, statusChangedAt: now,
  });
  return id;
}

function makeApp(db: TestDb) {
  const app = new Hono();
  app.route("/api/projects", createBoardMonitorRoute(db as never));
  return app;
}

describe("GET /api/projects/:id/board-monitor/next", () => {
  it("returns candidates ranked by score, highest first", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: 1, title: "Low leaf", priority: "low" });
    await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: 2, title: "High prio", priority: "high" });

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/board-monitor/next`);
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string; candidates: Array<{ title: string; score: { score: number } }> };
    expect(body.projectId).toBe(projectId);
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].title).toBe("High prio");
    expect(body.candidates[0].score.score).toBeGreaterThan(body.candidates[1].score.score);
  });

  it("respects the limit query param", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    for (let i = 1; i <= 5; i++) {
      await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: i, title: `Ticket ${i}` });
    }

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/board-monitor/next?limit=2`);
    const body = await res.json() as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);
  });

  it("does not persist a score (read-only preview)", async () => {
    const { db } = createTestDb();
    const { projectId, todoStatusId } = await seedProject(db);
    const issueId = await seedIssue(db, { projectId, statusId: todoStatusId, issueNumber: 1, title: "Solo" });

    const app = makeApp(db);
    await app.request(`/api/projects/${projectId}/board-monitor/next`);

    const [row] = await db.select({ lastStartScore: issues.lastStartScore }).from(issues).where(eq(issues.id, issueId));
    expect(row.lastStartScore).toBeNull();
  });

  it("returns an empty candidate list when the project has no Todo status", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "NoTodo", repoPath: "/tmp/no-todo-repo", repoName: "no-todo-repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });

    const app = makeApp(db);
    const res = await app.request(`/api/projects/${projectId}/board-monitor/next`);
    const body = await res.json() as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });
});
