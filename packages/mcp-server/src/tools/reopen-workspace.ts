import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, ne } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import * as gitService from "../git-service.js";
import { notifyBoard } from "../notify.js";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { setWorkspaceWorkingDir } from "@agentic-kanban/shared/lib/workspace-git-state";
import { mcpJson, mcpStructuredError, requireEntity } from "../db-utils.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * #1206 — re-create the worktree for a CLOSED workspace whose branch is still live
 * and unmerged. The server-side twin of `POST /api/workspaces/:id/reopen`
 * (`workspace-crud.service.ts`'s `reopenWorkspace`); this MCP tool mirrors the
 * same refusals since mcp-server cannot import server code.
 */
export function registerReopenWorkspace(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "reopen_workspace",
    "Re-create the worktree for a CLOSED workspace whose branch is still live and unmerged. " +
      "Use this to recover a workspace that was closed while its feature branch still carried " +
      "unmerged commits — the shape left behind by a manual close applied to real work. " +
      "Refuses if the workspace isn't closed, is direct, is already merged, its branch no " +
      "longer exists, or another open workspace already holds the issue.",
    {
      workspaceId: z.string().describe("The workspace ID to reopen"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;
      const workspace = r.value;

      if (workspace.status !== "closed") {
        return mcpStructuredError("WORKSPACE_NOT_CLOSED", "Workspace is not closed", { workspaceId });
      }
      if (workspace.isDirect) {
        return mcpStructuredError("WORKSPACE_IS_DIRECT", "Direct workspaces have no branch to reopen", { workspaceId });
      }
      if (workspace.mergedAt) {
        return mcpStructuredError("WORKSPACE_ALREADY_MERGED", "Workspace is already merged — nothing to reopen", { workspaceId });
      }
      if (!workspace.branch) {
        return mcpStructuredError("WORKSPACE_NO_BRANCH", "Workspace has no branch", { workspaceId });
      }

      const otherOpenRows = await db.select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(and(
          eq(schema.workspaces.issueId, workspace.issueId),
          ne(schema.workspaces.id, workspaceId),
          ne(schema.workspaces.status, "closed"),
        ))
        .limit(1);
      if (otherOpenRows.length > 0) {
        return mcpStructuredError(
          "ISSUE_HAS_OPEN_WORKSPACE",
          `Issue already has an open workspace (${otherOpenRows[0].id}) — close it before reopening this one`,
          { workspaceId, otherWorkspaceId: otherOpenRows[0].id },
        );
      }

      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, workspace.issueId))
        .limit(1);
      const projectId = issueRows[0]?.projectId;
      if (!projectId) {
        return mcpStructuredError("PROJECT_NOT_FOUND", "Could not resolve the workspace's project", { workspaceId });
      }
      const projectRows = await db.select({ repoPath: schema.projects.repoPath, defaultBranch: schema.projects.defaultBranch })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project?.repoPath) {
        return mcpStructuredError("PROJECT_NOT_FOUND", "Project has no repo path configured", { workspaceId });
      }
      const baseBranch = workspace.baseBranch || project.defaultBranch;
      if (!baseBranch) {
        return mcpStructuredError("NO_BASE_BRANCH", "No base branch configured for this project", { workspaceId });
      }

      try {
        await gitService.revParse(project.repoPath, workspace.branch);
      } catch {
        return mcpStructuredError("BRANCH_GONE", `Branch "${workspace.branch}" no longer exists in the repository`, { workspaceId, branch: workspace.branch });
      }

      try {
        const worktreePath = await gitService.createWorktree(project.repoPath, workspace.branch, baseBranch);

        await setWorkspaceWorkingDir(db, workspaceId, worktreePath);
        await setWorkspaceStatus(db, workspaceId, "idle", { caller: "mcp:reopen_workspace" });

        notifyBoard(projectId, "mcp_reopen_workspace");

        return mcpJson({ id: workspaceId, workingDir: worktreePath, status: "idle" });
      } catch (err) {
        return mcpStructuredError("REOPEN_FAILED", `Failed to reopen workspace: ${errorMessage(err)}`, { workspaceId });
      }
    },
  );
}
