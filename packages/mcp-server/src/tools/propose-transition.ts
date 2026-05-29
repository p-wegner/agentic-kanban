import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import {
  proposeTransition,
  getOutgoingTransitions,
} from "@agentic-kanban/shared/lib/workflow-engine";

/**
 * Advance a workspace to the next stage of its configurable workflow graph.
 * The agent calls this when a stage's work is complete; the engine validates
 * the transition against the graph's edges, enforces the per-node visit budget,
 * records the transition (history → analytics), and syncs the board status.
 */
export function registerProposeTransition(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;

  server.tool(
    "propose_transition",
    "Advance the current issue's workflow to the next stage. Call this when the work for the current stage is done. Pass the workspaceId from your workflow instructions (or the issueId), the target stage name (toNodeName), and a short summary of what you completed.",
    {
      workspaceId: z.string().optional().describe("The workspace ID (provided in your workflow instructions)"),
      issueId: z.string().optional().describe("Issue ID — used to resolve the active workspace if workspaceId is omitted"),
      toNodeName: z.string().optional().describe("Name of the target stage to move to (e.g. 'Review', 'Done')"),
      toNodeId: z.string().optional().describe("ID of the target node (alternative to toNodeName)"),
      summary: z.string().optional().describe("Short summary of what was completed at the current stage"),
    },
    async ({ workspaceId, issueId, toNodeName, toNodeId, summary }) => {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

      // Resolve the workspace: explicit id, else the active workspace for the issue.
      let resolvedWorkspaceId = workspaceId;
      if (!resolvedWorkspaceId && issueId) {
        const rows = await db
          .select({ id: schema.workspaces.id, status: schema.workspaces.status })
          .from(schema.workspaces)
          .where(and(eq(schema.workspaces.issueId, issueId), ne(schema.workspaces.status, "closed")))
          .orderBy(schema.workspaces.createdAt);
        if (rows.length > 0) resolvedWorkspaceId = rows[rows.length - 1].id;
      }
      if (!resolvedWorkspaceId) {
        return text("Provide a workspaceId (from your workflow instructions) or an issueId with an active workspace.");
      }

      const result = await proposeTransition(db, {
        workspaceId: resolvedWorkspaceId,
        toNodeId,
        toNodeName,
        summary,
        triggeredBy: "agent",
      });

      if (!result.ok) {
        return text(result.error ?? "Transition failed.");
      }

      // Notify the board so the UI reflects the new stage/status.
      const issueRows = await db
        .select({ projectId: schema.issues.projectId })
        .from(schema.workspaces)
        .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
        .where(eq(schema.workspaces.id, resolvedWorkspaceId))
        .limit(1);
      if (issueRows[0]?.projectId) {
        notifyBoard(issueRows[0].projectId, "mcp_propose_transition");
      }

      const next = (result.nextTransitions ?? []).map((t) => t.toNodeName);
      return text(
        JSON.stringify(
          {
            ok: true,
            movedTo: result.toNode?.name,
            status: result.statusName,
            terminal: next.length === 0,
            nextStages: next,
            guidance:
              next.length === 0
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
