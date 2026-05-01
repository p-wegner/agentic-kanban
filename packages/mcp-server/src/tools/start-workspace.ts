import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as gitService from "../git-service.js";

export function registerStartWorkspace(server: McpServer) {
  server.tool(
    "start_workspace",
    "Create a workspace for an issue: creates a git worktree and returns workspace info",
    {
      issueId: z.string().describe("The issue ID to create a workspace for"),
      repoPath: z.string().optional().describe("Absolute path to the git repository (auto-detected from project if omitted)"),
      branch: z.string().optional().describe("Branch name (defaults to 'workspace/{issueId-short}')"),
    },
    async ({ issueId, repoPath, branch }) => {
      // Look up the issue
      const issues = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${issueId} not found` }] };
      }

      // Resolve repoPath from issue → project chain if not provided
      let resolvedRepoPath = repoPath;
      if (!resolvedRepoPath) {
        const issue = issues[0];
        const projectRows = await db
          .select({ repoPath: schema.projects.repoPath })
          .from(schema.projects)
          .where(eq(schema.projects.id, issue.projectId))
          .limit(1);

        if (projectRows.length === 0 || !projectRows[0].repoPath) {
          return { content: [{ type: "text" as const, text: `Project has no repo path configured. Provide repoPath explicitly.` }] };
        }
        resolvedRepoPath = projectRows[0].repoPath;
      }

      const branchName = branch || `workspace/${issueId.slice(0, 8)}`;
      const id = randomUUID();
      const now = new Date().toISOString();

      try {
        const worktreePath = await gitService.createWorktree(resolvedRepoPath, branchName);

        await db.insert(schema.workspaces).values({
          id,
          issueId,
          branch: branchName,
          workingDir: worktreePath,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });

        const result = {
          id,
          issueId,
          branch: branchName,
          workingDir: worktreePath,
          status: "active",
          message: `Workspace created. Working directory: ${worktreePath}`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
