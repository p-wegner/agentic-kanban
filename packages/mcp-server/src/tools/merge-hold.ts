import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiText, mcpText } from "../board-call.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { prodDeps, type ToolDeps } from "./deps.js";

/**
 * set_merge_hold / release_merge_hold (#1164) delegate to
 * `POST|DELETE /api/workspaces/:id/merge-hold` — parks/releases ONE workspace so the monitor
 * walk, the auto-merge orchestrator, and the merge-train reconciler all skip it, without
 * disabling auto-merge for the rest of the project. Idempotent both ways.
 *
 * Two separate registrar functions, not one registering both tools: `createConfiguredServer`
 * calls every `TOOL_REGISTRARS` entry once PER KEY, so a single function registering two tools
 * would run twice and `McpServer` rejects a duplicate tool name on the second pass.
 */
export function registerSetMergeHold(server: McpServer, deps: ToolDeps = prodDeps) {
  void deps;

  server.tool(
    "set_merge_hold",
    "Place an operator merge-hold on a workspace (#1164) — parks it so the monitor walk, the auto-merge orchestrator, and the merge-train reconciler all skip it, without disabling auto-merge for the whole project. Idempotent: re-holding an already-held workspace just updates the reason. Requires the board server to be running.",
    {
      workspaceId: z.string().describe("The workspace ID to hold"),
      reason: z.string().optional().describe("Why the workspace is being held"),
    },
    async ({ workspaceId, reason }) => {
      let result: Awaited<ReturnType<typeof boardApiText>>;
      try {
        result = await boardApiText(`/api/workspaces/${workspaceId}/merge-hold`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reason ? { reason } : {}),
        });
      } catch (err) {
        return mcpText(
          `Hold failed: could not reach the board server (${errorMessage(err)}). The board server must be running.`,
        );
      }
      if (!result.ok) {
        return mcpText(`Hold not completed (HTTP ${result.status}): ${result.text || result.statusText}`);
      }
      return mcpText(result.text);
    },
  );
}

export function registerReleaseMergeHold(server: McpServer, deps: ToolDeps = prodDeps) {
  void deps;

  server.tool(
    "release_merge_hold",
    "Release a workspace's operator merge-hold (#1164), letting the monitor walk, auto-merge orchestrator, and merge-train reconciler resume treating it normally. A no-op if it was not held. Requires the board server to be running.",
    {
      workspaceId: z.string().describe("The workspace ID to release"),
    },
    async ({ workspaceId }) => {
      let result: Awaited<ReturnType<typeof boardApiText>>;
      try {
        result = await boardApiText(`/api/workspaces/${workspaceId}/merge-hold`, {
          method: "DELETE",
        });
      } catch (err) {
        return mcpText(
          `Release failed: could not reach the board server (${errorMessage(err)}). The board server must be running.`,
        );
      }
      if (!result.ok) {
        return mcpText(`Release not completed (HTTP ${result.status}): ${result.text || result.statusText}`);
      }
      return mcpText(result.text);
    },
  );
}
