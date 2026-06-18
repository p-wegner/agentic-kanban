import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { workspaceClosedError, workspaceMissingWorkingDirError, workspaceNotFoundError } from "../db-utils.js";
import { boardApiUrl } from "../server-url.js";
import { prodDeps, type ToolDeps } from "./deps.js";

/**
 * merge_workspace delegates to the board server's safe merge path
 * (POST /api/workspaces/:id/merge → workspaceService.mergeWorkspaceDeduped)
 * instead of re-implementing a weaker merge inline.
 *
 * The previous inline implementation re-did the git merge / worktree cleanup /
 * status transition itself and so bypassed every safety net the UI merge has:
 * the per-repo merge LOCK (concurrent-merge dedup), the pre-merge BACKUP/rollback,
 * conflict detection → fix-and-merge recovery, and the merge-timeline recording.
 * An agent merging over MCP got a strictly less safe operation than a human.
 * Delegating routes all four transports (UI / MCP / CLI / monitor) through the
 * one authoritative merge service. Requires the board server to be running — it
 * is the merge authority and already owns the worktree/lock state.
 *
 * The cheap structured pre-checks (not-found / closed / missing-workingDir) stay
 * local so obviously-invalid calls fail fast with a machine-readable error and
 * never hit the network (the workspace-edge-errors contract).
 */
export function registerMergeWorkspace(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "merge_workspace",
    "Merge a workspace branch into the project's default branch, close the workspace, and auto-transition the issue to Done. Delegates to the board server's safe merge path — per-repo merge lock, pre-merge backup/rollback, OpenSpec delta application, and conflict detection with fix-and-merge recovery — so an MCP merge has the same safety net as the UI. Requires the board server to be running.",
    {
      workspaceId: z.string().describe("The workspace ID to merge"),
    },
    async ({ workspaceId }) => {
      // Fast structured pre-checks (no network): obviously-invalid calls fail here.
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      if (wsRows.length === 0) return workspaceNotFoundError(workspaceId);
      const workspace = wsRows[0];
      if (workspace.status === "closed") return workspaceClosedError(workspaceId);
      if (!workspace.isDirect && !workspace.workingDir?.trim()) {
        return workspaceMissingWorkingDirError(workspaceId);
      }

      // Delegate the actual merge to the authoritative server endpoint.
      let res: Response;
      try {
        res = await fetch(boardApiUrl(`/api/workspaces/${workspaceId}/merge`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Merge failed: could not reach the board server (${err instanceof Error ? err.message : String(err)}). The board server must be running to merge safely.`,
          }],
        };
      }

      const text = await res.text();
      if (!res.ok) {
        // The safe path surfaces distinct signals here — e.g. 409 (a merge is
        // already in progress for this repo), 503 (the merge build/verify failed,
        // not a conflict), or a conflict that should be routed to fix-and-merge.
        return {
          content: [{ type: "text" as const, text: `Merge not completed (HTTP ${res.status}): ${text}` }],
        };
      }
      return { content: [{ type: "text" as const, text }] };
    },
  );
}
