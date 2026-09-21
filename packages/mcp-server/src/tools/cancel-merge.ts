import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiText, mcpText } from "../board-call.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { prodDeps, type ToolDeps } from "./deps.js";

/**
 * cancel_merge (#1164) delegates to `POST /api/workspaces/:id/merge/cancel` — the targeted
 * lever for a single stuck/red workspace, so an operator does not have to reach for
 * `auto_merge_disabled_<projectId>` (which stops merging for the whole project) or kill gate
 * processes by hand. Idempotent: calling it on a workspace with nothing running is a harmless
 * 200, not an error, so it never needs a pre-check the way `merge_workspace` does.
 */
export function registerCancelMerge(server: McpServer, deps: ToolDeps = prodDeps) {
  void deps; // no local pre-checks needed — the route itself is safe on any workspace state
  server.tool(
    "cancel_merge",
    "Cancel a workspace's in-flight or queued merge — removes a queued verify chain, aborts an in-flight gate run (killing its process tree), releases the merge lock if held, and marks the tracked job cancelled. Use this to unstick ONE workspace with a genuinely red gate without disabling auto-merge for the rest of the project. Idempotent: safe to call even if nothing is running. Requires the board server to be running.",
    {
      workspaceId: z.string().describe("The workspace ID whose merge should be cancelled"),
      reason: z.string().optional().describe("Why the merge is being cancelled (recorded on the job)"),
    },
    async ({ workspaceId, reason }) => {
      let result: Awaited<ReturnType<typeof boardApiText>>;
      try {
        result = await boardApiText(`/api/workspaces/${workspaceId}/merge/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reason ? { reason } : {}),
        });
      } catch (err) {
        return mcpText(
          `Cancel failed: could not reach the board server (${errorMessage(err)}). The board server must be running.`,
        );
      }
      if (!result.ok) {
        return mcpText(`Cancel not completed (HTTP ${result.status}): ${result.text || result.statusText}`);
      }
      return mcpText(result.text);
    },
  );
}
