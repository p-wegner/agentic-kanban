import { Hono } from "hono";
import { db } from "../db/index.js";
import { projects, projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "../services/git-info.service.js";
import type { Database } from "../db/index.js";

export function createProjectsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/projects
  router.get("/", async (c) => {
    const result = await database.select().from(projects);
    return c.json(result);
  });

  // POST /api/projects
  router.post("/", async (c) => {
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    if (!body.repoPath) {
      return c.json({ error: "repoPath is required" }, 400);
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(body.repoPath);
    } catch (err) {
      return c.json(
        { error: `Invalid repo: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    const name = body.name || repoInfo.repoName;

    await database.insert(projects).values({
      id,
      name,
      description: body.description ?? null,
      color: body.color ?? null,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ id, name, repoPath: repoInfo.repoPath }, 201);
  });

  // GET /api/projects/:id/statuses
  router.get("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const result = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);
    return c.json(result);
  });

  // POST /api/projects/:id/statuses
  router.post("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    await database.insert(projectStatuses).values({
      id,
      projectId,
      name: body.name,
      sortOrder: body.sortOrder ?? 0,
      createdAt: now,
    });

    return c.json({ id, projectId, name: body.name }, 201);
  });

  // GET /api/projects/:id/board
  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const statuses = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);

    const projectIssues = await database
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    const result = statuses.map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      issues: projectIssues.filter((i) => i.statusId === s.id),
    }));

    return c.json(result);
  });

  return router;
}

export const projectsRoute = createProjectsRoute();
