import { Hono } from "hono";
import { projects, projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../../db/index.js";
import { buildWorkspaceSummaryMap, buildBlockedMap, buildTagMap, buildGraphEdges } from "../../services/board-aggregation.service.js";

export function createBoardRoutes(database: Database) {
  const router = new Hono();

  // MUST be registered before /:id routes to avoid matching /all as :id
  router.get("/all/workspaces", async (c) => {
    const allProjects = await database.select().from(projects);

    const results = await Promise.all(
      allProjects.map(async (project) => {
        const statuses = await database
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, project.id))
          .orderBy(projectStatuses.sortOrder);

        const projectIssues = await database
          .select({
            id: issues.id,
            issueNumber: issues.issueNumber,
            title: issues.title,
            priority: issues.priority,
            issueType: issues.issueType,
            sortOrder: issues.sortOrder,
            statusId: issues.statusId,
            projectId: issues.projectId,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
            statusName: projectStatuses.name,
          })
          .from(issues)
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(eq(issues.projectId, project.id))
          .orderBy(issues.sortOrder);

        const issueIds = projectIssues.map((i) => i.id);
        const workspaceSummaryMap = await buildWorkspaceSummaryMap(issueIds, project.defaultBranch, database);

        const issuesWithWorkspaces = projectIssues
          .map((issue) => {
            const wsSummary = workspaceSummaryMap.get(issue.id);
            return { ...issue, workspaceSummary: wsSummary };
          })
          .filter((i) => i.workspaceSummary && i.workspaceSummary.total > 0);

        return {
          projectId: project.id,
          projectName: project.name,
          issues: issuesWithWorkspaces,
        };
      })
    );

    return c.json(results);
  });

  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ id: projects.id, defaultBranch: projects.defaultBranch })
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
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        issueType: issues.issueType,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    const issueIds = projectIssues.map((i) => i.id);
    const defaultBranch = projectRows[0].defaultBranch;

    const [workspaceSummaryMap, blockedMap, issueTagMap] = await Promise.all([
      buildWorkspaceSummaryMap(issueIds, defaultBranch, database),
      buildBlockedMap(issueIds, database),
      buildTagMap(issueIds, database),
    ]);

    const issuesWithBlocked = projectIssues.map((issue) => {
      const wsSummary = workspaceSummaryMap.get(issue.id);
      const blocked = blockedMap.get(issue.id);
      return {
        ...issue,
        ...(wsSummary ? { workspaceSummary: wsSummary } : {}),
        ...(blocked ? { isBlocked: blocked.isBlocked, dependencyCount: blocked.dependencyCount } : {}),
      };
    });

    const result = statuses.map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      issues: issuesWithBlocked.filter((i) => i.statusId === s.id).map((i) => ({
        ...i,
        tags: issueTagMap.get(i.id) ?? [],
      })),
    }));

    return c.json(result);
  });

  router.get("/:id/graph", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) return c.json({ error: "Project not found" }, 404);

    const projectIssues = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        issueType: issues.issueType,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    const issueIds = projectIssues.map((i) => i.id);
    const edges = await buildGraphEdges(issueIds, database);

    const blockedIds = new Set(
      edges
        .filter((e) => e.type === "depends_on" || e.type === "blocked_by")
        .map((e) => e.issueId)
    );

    const nodes = projectIssues.map((i) => ({ ...i, isBlocked: blockedIds.has(i.id) }));

    return c.json({ nodes, edges });
  });

  return router;
}
