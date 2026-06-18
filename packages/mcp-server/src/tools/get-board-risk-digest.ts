import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prodDeps, type ToolDeps } from "./deps.js";
import { resolveActiveProjectId } from "../db-utils.js";

const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

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

        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/projects/${pid}/board-risk-digest`);
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to get board risk digest: ${res.statusText}` }] };
        }
        const digest = await res.json();
        return { content: [{ type: "text" as const, text: JSON.stringify(digest, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
}
