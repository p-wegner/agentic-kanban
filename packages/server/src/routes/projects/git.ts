import { Hono } from "hono";
import { projects, projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { listBranches } from "../../services/git.service.js";
import { getProjectGitStats } from "../../services/git-info.service.js";
import type { Database } from "../../db/index.js";

export function createGitRoutes(database: Database) {
  const router = new Hono();

  router.get("/:id/branches", async (c) => {
    const projectId = c.req.param("id");
    const projectRows = await database
      .select({ id: projects.id, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const branches = await listBranches(projectRows[0].repoPath);
      return c.json(branches);
    } catch (err) {
      return c.json(
        { error: `Failed to list branches: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  router.get("/:id/stats", async (c) => {
    const projectId = c.req.param("id");
    const projectRows = await database
      .select({ id: projects.id, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) return c.json({ error: "Project not found" }, 404);
    const { repoPath, defaultBranch } = projectRows[0];

    const { commitCount, recentCommits, detectedBranch } = getProjectGitStats(repoPath, defaultBranch);

    const issueRows = await database
      .select({ statusName: projectStatuses.name, count: sql<number>`count(*)` })
      .from(issues)
      .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .groupBy(projectStatuses.name);
    const issueCounts: Record<string, number> = {};
    for (const row of issueRows) if (row.statusName != null) issueCounts[row.statusName] = Number(row.count);

    return c.json({ commitCount, recentCommits, issueCounts, detectedBranch });
  });

  return router;
}
