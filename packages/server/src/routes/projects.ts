import { Hono } from "hono";
import { db } from "../db/index.js";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages, diffComments, issueDependencies } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "../services/git-info.service.js";
import { listBranches, listWorktrees, getDiffShortstat, removeWorktree } from "../services/git.service.js";
import type { Database } from "../db/index.js";
import { sep } from "node:path";

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

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

    // Reject duplicate repo paths
    const existing = await database
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.repoPath, repoInfo.repoPath))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Project "${existing[0].name}" is already registered at this path` }, 409);
    }

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

    for (const status of DEFAULT_STATUSES) {
      await database.insert(projectStatuses).values({
        id: randomUUID(),
        projectId: id,
        name: status.name,
        sortOrder: status.sortOrder,
        isDefault: status.isDefault,
        createdAt: now,
      });
    }

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

  // GET /api/projects/:id/branches
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

  // GET /api/projects/:id/worktrees
  router.get("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath, defaultBranch } = projectRows[0];

    let gitWorktrees: { path: string; branch: string }[];
    try {
      gitWorktrees = await listWorktrees(repoPath);
    } catch (err) {
      return c.json(
        { error: `Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    // Fetch all non-closed workspaces for this project, join with issues for info
    const projectWorkspaces = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        baseBranch: workspaces.baseBranch,
        isDirect: workspaces.isDirect,
        status: workspaces.status,
        issueNumber: issues.issueNumber,
        issueTitle: issues.title,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(issues.projectId, projectId));

    // Index workspaces by workingDir (normalized path)
    const wsByDir = new Map<string, typeof projectWorkspaces[number]>();
    for (const ws of projectWorkspaces) {
      if (ws.workingDir) {
        wsByDir.set(ws.workingDir.replace(/\//g, sep), ws);
      }
    }

    const result = await Promise.all(
      gitWorktrees.map(async (wt, index) => {
        // First worktree is always the primary checkout (git guarantee)
        const isMain = index === 0;
        const normalizedWtPath = wt.path.replace(/\//g, sep);

        // Match workspace by exact path, or by direct workspace whose workingDir is inside this worktree
        let ws = wsByDir.get(normalizedWtPath);
        if (!ws && isMain) {
          for (const [, candidate] of wsByDir) {
            if (candidate.isDirect && candidate.workingDir && candidate.workingDir.startsWith(normalizedWtPath)) {
              ws = candidate;
              break;
            }
          }
        }

        let diffStats: { filesChanged: number; insertions: number; deletions: number } | undefined;
        if (!isMain) {
          const base = ws?.baseBranch || defaultBranch;
          diffStats = await getDiffShortstat(wt.path, base);
          if (diffStats.filesChanged === 0 && diffStats.insertions === 0 && diffStats.deletions === 0) {
            diffStats = undefined;
          }
        }

        return {
          path: wt.path,
          branch: isMain ? defaultBranch : wt.branch.replace(/^refs\/heads\//, ""),
          isMain,
          workspace: ws ? {
            id: ws.id,
            status: ws.status,
            isDirect: ws.isDirect,
            issueId: ws.issueId,
            issueNumber: ws.issueNumber,
            issueTitle: ws.issueTitle,
          } : undefined,
          diffStats,
        };
      }),
    );

    return c.json(result);
  });

  // DELETE /api/projects/:id/worktrees — remove a worktree (and optionally its workspace)
  router.delete("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json<{ path?: string; workspaceId?: string }>();

    if (!body.path && !body.workspaceId) {
      return c.json({ error: "path or workspaceId is required" }, 400);
    }

    const projectRows = await database
      .select({ repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath } = projectRows[0];
    let removedPath = body.path;

    // If workspaceId given, look up the workspace to find its workingDir
    if (body.workspaceId) {
      const wsRows = await database
        .select({ id: workspaces.id, workingDir: workspaces.workingDir })
        .from(workspaces)
        .where(eq(workspaces.id, body.workspaceId))
        .limit(1);

      if (wsRows.length === 0) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const ws = wsRows[0];
      if (ws.workingDir) removedPath = ws.workingDir;

      // Cascade delete: diff comments → session messages → sessions → workspace
      const wsSessions = await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.workspaceId, ws.id));

      await database.delete(diffComments).where(eq(diffComments.workspaceId, ws.id));
      if (wsSessions.length > 0) {
        const sessionIds = wsSessions.map(s => s.id);
        await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
      }
      await database.delete(sessions).where(eq(sessions.workspaceId, ws.id));
      await database.delete(workspaces).where(eq(workspaces.id, ws.id));
    }

    // Remove git worktree
    if (removedPath) {
      try {
        await removeWorktree(repoPath, removedPath);
      } catch {
        // Best effort — worktree may already be removed
      }
    }

    return c.json({ success: true });
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
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        skipAutoReview: issues.skipAutoReview,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    // Fetch workspace summaries grouped by issueId
    const issueIds = projectIssues.map((i) => i.id);
    const workspaceSummaryMap = new Map<string, { total: number; active: number; idle: number; closed: number; branches: string[]; main?: { id: string; branch: string; status: "active" | "reviewing" | "idle" | "closed" } }>();

    if (issueIds.length > 0) {
      const wsRows = await database
        .select({
          issueId: workspaces.issueId,
          status: workspaces.status,
          branch: workspaces.branch,
          count: sql<number>`count(*)`.as("count"),
        })
        .from(workspaces)
        .where(inArray(workspaces.issueId, issueIds))
        .groupBy(workspaces.issueId, workspaces.status, workspaces.branch);

      for (const row of wsRows) {
        let summary = workspaceSummaryMap.get(row.issueId);
        if (!summary) {
          summary = { total: 0, active: 0, idle: 0, closed: 0, branches: [] };
          workspaceSummaryMap.set(row.issueId, summary);
        }
        summary.total += row.count;
        if (row.status === "active" || row.status === "reviewing") {
          summary.active += row.count;
        } else if (row.status === "closed") {
          summary.closed += row.count;
        } else {
          summary.idle += row.count;
        }
        if (!summary.branches.includes(row.branch)) {
          summary.branches.push(row.branch);
        }
      }

      // Determine main workspace per issue (active > idle > closed, tie-break by updatedAt)
      const wsDetailRows = await database
        .select({
          id: workspaces.id,
          issueId: workspaces.issueId,
          branch: workspaces.branch,
          status: workspaces.status,
          updatedAt: workspaces.updatedAt,
        })
        .from(workspaces)
        .where(inArray(workspaces.issueId, issueIds));

      const mainWorkspaceMap = new Map<string, { id: string; branch: string; status: string; updatedAt: string }>();
      const statusPriority = (s: string) => s === "active" || s === "reviewing" ? 0 : s === "idle" ? 1 : 2;
      for (const row of wsDetailRows) {
        const existing = mainWorkspaceMap.get(row.issueId);
        if (!existing) {
          mainWorkspaceMap.set(row.issueId, row);
          continue;
        }
        const existingP = statusPriority(existing.status);
        const rowP = statusPriority(row.status);
        if (rowP < existingP || (rowP === existingP && row.updatedAt > existing.updatedAt)) {
          mainWorkspaceMap.set(row.issueId, row);
        }
      }

      for (const [issueId, summary] of workspaceSummaryMap) {
        const mainWs = mainWorkspaceMap.get(issueId);
        if (mainWs) {
          summary.main = { id: mainWs.id, branch: mainWs.branch, status: mainWs.status as "active" | "reviewing" | "idle" | "closed" };
        }
      }
    }

    // Attach workspace summaries to issues
    const issuesWithSummary: Array<typeof projectIssues[number] & { workspaceSummary?: typeof workspaceSummaryMap extends Map<string, infer V> ? V : never }> = projectIssues.map((issue) => {
      const wsSummary = workspaceSummaryMap.get(issue.id);
      return wsSummary ? { ...issue, workspaceSummary: wsSummary } : issue;
    });

    // Compute isBlocked for each issue
    const issuesWithBlocked: Array<typeof issuesWithSummary[number] & { isBlocked?: boolean }> = [...issuesWithSummary];
    if (issueIds.length > 0) {
      const depRows = await database
        .select({
          issueId: issueDependencies.issueId,
          dependsOnId: issueDependencies.dependsOnId,
        })
        .from(issueDependencies)
        .where(inArray(issueDependencies.issueId, issueIds));

      // Map each depended-on issue to its status name
      const dependsOnIds = [...new Set(depRows.map(d => d.dependsOnId))];
      const depStatusMap = new Map<string, string>();
      if (dependsOnIds.length > 0) {
        const depStatuses = await database
          .select({ id: issues.id, statusName: projectStatuses.name })
          .from(issues)
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(inArray(issues.id, dependsOnIds));
        for (const ds of depStatuses) depStatusMap.set(ds.id, ds.statusName);
      }

      // Group deps by issue
      const depsByIssue = new Map<string, string[]>();
      for (const dep of depRows) {
        let arr = depsByIssue.get(dep.issueId);
        if (!arr) { arr = []; depsByIssue.set(dep.issueId, arr); }
        arr.push(dep.dependsOnId);
      }

      for (let i = 0; i < issuesWithBlocked.length; i++) {
        const issue = issuesWithBlocked[i];
        const deps = depsByIssue.get(issue.id);
        if (deps && deps.length > 0) {
          const isBlocked = deps.some(depId => { const s = depStatusMap.get(depId); return s !== "Done" && s !== "AI Reviewed"; });
          issuesWithBlocked[i] = { ...issue, isBlocked };
        }
      }
    }

    const result = statuses.map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      issues: issuesWithBlocked.filter((i) => i.statusId === s.id),
    }));

    return c.json(result);
  });

  return router;
}

export const projectsRoute = createProjectsRoute();
