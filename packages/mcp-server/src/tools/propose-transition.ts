import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpText } from "../db-utils.js";
import { advanceWorkflow, resolveWorkflowWorkspaceId } from "./workflow-transition-support.js";
import { getOutgoingTransitions } from "@agentic-kanban/shared/lib/workflow-engine";

/**
 * Advance a workspace to the next stage of its configurable workflow graph.
 * The agent calls this when a stage's work is complete; the engine validates
 * the transition against the graph's edges, enforces the per-node visit budget,
 * records the transition (history → analytics), and syncs the board status.
 *
 * The resolve/advance body is shared with `clarify_or_propose` (#772) — see
 * `workflow-transition-support.ts`.
 */
export function registerProposeTransition(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "propose_transition",
    "Advance the current issue's workflow to the next stage. Call this when the work for the current stage is done. Pass the workspaceId from your workflow instructions (or the issueId), the target stage name (toNodeName), and a short summary of what you completed.",
    {
      workspaceId: z.string().optional().describe("The workspace ID (provided in your workflow instructions)"),
      issueId: z.string().optional().describe("Issue ID — used to resolve the active workspace if workspaceId is omitted"),
      toNodeName: z.string().optional().describe("Name of the target stage to move to (e.g. 'Review', 'Done'). Omit to let the workflow auto-route based on conditions (e.g. tests pass/fail)."),
      toNodeId: z.string().optional().describe("ID of the target node (alternative to toNodeName)"),
      summary: z.string().optional().describe("Short summary of what was completed at the current stage"),
      testsPassed: z.boolean().optional().describe("Whether the tests you ran for this stage passed — used to auto-route tests_pass/tests_fail edges"),
    },
    async ({ workspaceId, issueId, toNodeName, toNodeId, summary, testsPassed }) => {

      // Resolve the workspace: explicit id, else the active workspace for the issue.
      const resolvedWorkspaceId = await resolveWorkflowWorkspaceId(deps, { workspaceId, issueId });
      if (!resolvedWorkspaceId) {
        return mcpText("Provide a workspaceId (from your workflow instructions) or an issueId with an active workspace.");
      }

      const advanced = await advanceWorkflow(deps, {
        workspaceId: resolvedWorkspaceId,
        toNodeId,
        toNodeName,
        summary,
        testsPassed,
        reason: "mcp_propose_transition",
      });
      if (!advanced.ok) return advanced.error;

      return mcpText(
        JSON.stringify(
          {
            ok: true,
            movedTo: advanced.movedTo,
            autoRouted: advanced.autoRouted,
            status: advanced.status,
            terminal: advanced.terminal,
            nextStages: advanced.nextStages,
            guidance:
              advanced.terminal
                ? "This is a terminal stage — the workflow is complete."
                : "Continue working; when ready, call propose_transition again toward one of nextStages.",
          },
          null,
          2,
        ),
      );
    },
  );
}

// Re-exported for potential reuse/testing.
export { getOutgoingTransitions };
