import { Hono } from "hono";
import { projects, workspaces, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { sep } from "node:path";
import { listWorktrees, getDiffShortstat, removeWorktree } from "../../services/git.service.js";
import type { Database } from "../../db/index.js";
import { deleteWorkspaceCascade } from "../../repositories/workspace.repository.js";

export function createWorktreeRoutes(database: Database) {
  const router = new Hono();

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

    const wsByDir = new Map<string, typeof projectWorkspaces[number]>();
    for (const ws of projectWorkspaces) {
      if (ws.workingDir) {
        wsByDir.set(ws.workingDir.replace(/\//g, sep), ws);
      }
    }

    const result = await Promise.all(
      gitWorktrees.map(async (wt, index) => {
        const isMain = index === 0;
        const normalizedWtPath = wt.path.replace(/\//g, sep);

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
          if (base) {
            diffStats = await getDiffShortstat(wt.path, base);
            if (diffStats.filesChanged === 0 && diffStats.insertions === 0 && diffStats.deletions === 0) {
              diffStats = undefined;
            }
          }
        }

        return {
          path: wt.path,
          branch: isMain ? (defaultBranch ?? (wt.branch.replace(/^refs\/heads\//, "") || "(unset)")) : wt.branch.replace(/^refs\/heads\//, ""),
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

      await deleteWorkspaceCascade(ws.id, database);
    }

    if (removedPath) {
      try {
        await removeWorktree(repoPath, removedPath);
      } catch {
        // Best effort
      }
    }

    return c.json({ success: true });
  });

  router.post("/:id/worktrees/open", async (c) => {
    const body = await c.req.json<{ path: string }>();
    if (!body.path) return c.json({ error: "path is required" }, 400);

    const { spawn } = await import("node:child_process");
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "win32") {
      cmd = "explorer";
      args = [body.path.replace(/\//g, "\\")];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [body.path];
    } else {
      cmd = "xdg-open";
      args = [body.path];
    }

    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return c.json({ success: true });
  });

  return router;
}
