import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { resolveActiveProjectId } from "../db-utils.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function registerGetBoardRiskDigest(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "get_board_risk_digest",
    "Get a risk digest of the current board state. Summarizes merge blockers (conflicts or idle In-Review), stale sessions (error or running with no activity for 2+ hours), low backlog risk, and board health issues needing attention. Returns counts and the top 3 actionable items with issue numbers and short reasons. Use this when a user asks about board risks, blockers, or health.",
    {
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
    },
    async ({ projectId }) => {
      try {
        const rpid = await resolveActiveProjectId(db, schema, projectId);
        if (!rpid.ok) return rpid.error;
        const pid = rpid.projectId;

        const { ok, statusText, data } = await boardApi(`/api/projects/${pid}/board-risk-digest`);
        if (!ok) return mcpText(`Failed to get board risk digest: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpText(`Error: ${errorMessage(err)}`);
      }
    },
  );
}
