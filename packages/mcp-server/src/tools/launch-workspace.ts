import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText } from "../board-call.js";
import { eq } from "drizzle-orm";
import { mcpStructuredError, workspaceNotFoundError, workspaceClosedError } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * launch_workspace — mirror of CLI `workspace launch <workspace-id>`.
 *
 * Difference from relaunch_workspace: `relaunch_workspace` requires the workspace
 * to already be in `idle` status and requires an explicit prompt. `launch_workspace`
 * auto-builds the prompt from the issue title+description when none is provided
 * (matching CLI behaviour), and accepts the workspace in any non-closed status
 * (the server-side /launch endpoint enforces the idle guard).
 *
 * Both call POST /api/workspaces/:id/launch — prefer this tool when you have a
 * workspaceId and want a sensible default prompt.
 */
export function registerLaunchWorkspace(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "launch_workspace",
    "Launch (or re-launch) a workspace's agent session. Mirrors CLI `workspace launch <workspace-id>`. " +
      "Auto-builds the prompt from the issue title+description when no prompt is supplied. " +
      "The server enforces that the workspace must be idle before launch. " +
      "Prefer relaunch_workspace when you already have a custom prompt ready; use this tool " +
      "when you want the default issue-derived prompt.",
    {
      workspaceId: z.string().describe("The workspace ID to launch"),
      prompt: z
        .string()
        .optional()
        .describe("Prompt to send to the agent. Defaults to the issue title + description when omitted."),
    },
    async ({ workspaceId, prompt }) => {
      // Look up the workspace
      const wsRows = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      if (wsRows.length === 0) return workspaceNotFoundError(workspaceId);

      const workspace = wsRows[0];
      if (workspace.status === "closed") return workspaceClosedError(workspaceId);

      // Build default prompt from issue title + description when not provided
      let effectivePrompt = prompt;
      if (!effectivePrompt) {
        const issueRows = await db
          .select({ title: schema.issues.title, description: schema.issues.description })
          .from(schema.issues)
          .where(eq(schema.issues.id, workspace.issueId))
          .limit(1);
        if (issueRows.length > 0) {
          effectivePrompt = issueRows[0].description
            ? `${issueRows[0].title}\n\n${issueRows[0].description}`
            : issueRows[0].title ?? "Continue working on this issue.";
        } else {
          effectivePrompt = "Continue working on this issue.";
        }
      }

      try {
        const { ok, statusText, data: raw } = await boardApi(`/api/workspaces/${workspaceId}/launch`, {
          method: "POST",
          body: JSON.stringify({ prompt: effectivePrompt }),
        });
        const data = (raw ?? {}) as Record<string, unknown>;

        if (!ok) {
          return mcpStructuredError("LAUNCH_FAILED", boardErrorText(raw, statusText), { workspaceId });
        }

        // Notify the board so the UI updates
        const issueRows = await db
          .select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, workspace.issueId))
          .limit(1);
        if (issueRows[0]?.projectId) {
          notifyBoard(issueRows[0].projectId, "mcp_launch_workspace");
        }

        return mcpJson({ id: workspaceId, sessionId: data.sessionId });
      } catch (err) {
        return mcpText(`Launch failed: ${errorMessage(err)}`);
      }
    },
  );
}
