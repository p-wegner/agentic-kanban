import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import * as gitService from "../git-service.js";
import { notifyBoard } from "../notify.js";

export function registerMergeWorkspace(server: McpServer) {
  server.tool(
    "merge_workspace",
    "Merge a workspace branch into the project's default branch, close the workspace, and auto-transition the issue to Done",
    {
      workspaceId: z.string().describe("The workspace ID to merge"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      if (wsRows.length === 0) {
        return { content: [{ type: "text" as const, text: `Workspace ${workspaceId} not found` }] };
      }

      const workspace = wsRows[0];

      // Resolve project info
      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, workspace.issueId))
        .limit(1);
      if (issueRows.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${workspace.issueId} not found` }] };
      }
      const projectId = issueRows[0].projectId;

      const projectRows = await db.select({
        repoPath: schema.projects.repoPath,
        defaultBranch: schema.projects.defaultBranch,
      }).from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .limit(1);
      if (projectRows.length === 0 || !projectRows[0].repoPath) {
        return { content: [{ type: "text" as const, text: "Project has no repo path configured" }] };
      }

      const { repoPath } = projectRows[0];

      try {
        // Direct workspace: just close, no merge
        if (workspace.isDirect) {
          const now = new Date().toISOString();
          await db.update(schema.workspaces)
            .set({ status: "closed", updatedAt: now })
            .where(eq(schema.workspaces.id, workspaceId));

          await autoTransitionDone(projectId, workspace.issueId, now);
          notifyBoard(projectId, "mcp_merge_workspace");

          return {
            content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, message: "Direct workspace closed (no merge needed)" }, null, 2) }],
          };
        }

        // Regular workspace: merge branch
        const mergeOutput = await gitService.mergeBranch(repoPath, workspace.branch);

        // Cleanup worktree
        if (workspace.workingDir) {
          try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch {}
        }

        const now = new Date().toISOString();
        await db.update(schema.workspaces)
          .set({ status: "closed", workingDir: null, updatedAt: now })
          .where(eq(schema.workspaces.id, workspaceId));

        await autoTransitionDone(projectId, workspace.issueId, now);
        notifyBoard(projectId, "mcp_merge_workspace");

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, mergeOutput }, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Merge failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}

async function autoTransitionDone(projectId: string, issueId: string, now: string) {
  try {
    const statuses = await db.select().from(schema.projectStatuses)
      .where(eq(schema.projectStatuses.projectId, projectId));
    const doneStatus = statuses.find(s => s.name === "Done");
    if (doneStatus) {
      await db.update(schema.issues)
        .set({ statusId: doneStatus.id, updatedAt: now })
        .where(eq(schema.issues.id, issueId));
    }
  } catch (err) {
    console.error("[merge-workspace] Failed to auto-transition issue to Done:", err);
  }
}
